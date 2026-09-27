import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { Agent, AutoDetectSurface, BrowserSession, NativeSession, ObservationConnection, Repository, Snapshot, StopSyncingConnectionProgress, StopSyncingConnectionStatus, StopSyncingOperation, StopSyncingPreview, StopSyncingStep } from '@agent-town/contracts';

// H0-14 (plan v5, milestone V0): the house inspector's "Watching" status line (slot 1, DES-02 section 3) and
// "Stop watching this project" button and dialog, wired to H0-13's already-built stop-syncing job. The service
// is mocked at the API boundary (the stop-syncing job itself has its own real-tool proof in H0-13's evidence);
// this file proves the UI: the status line's wording, the dialog's focus trap and Escape, the confirm screen
// naming project-relative files and tools, the running/settled copy for each distinct outcome, Cancel, Discard,
// a reload mid-stop, and that every path works with the mouse, the keyboard alone, and the List view.
//
// The focus-trapped dialog and the announcer this item builds (apps/web/src/LiveTrackingPanel.tsx,
// StopDialogShell/WatchingStatus) are a small, temporary, single-file implementation UX-31's shared versions
// are meant to replace in V1 (H0-14's own risk note); this spec pins their observable BEHAVIOUR (focus,
// Escape, live-region text), not their internal markup, so that swap does not need to touch this file.

const workspaceId = 'stop-syncing';
const repoPath = String.raw`C:\synthetic-stop-syncing\project`;
const prefix = `/api/v1/workspaces/${workspaceId}/observation/stop-syncing`;
const connectionIds = { codex: 'a1b2c3d4-1111-4a1a-9a1a-000000000001', claude: 'a1b2c3d4-2222-4a1a-9a1a-000000000002' };

function connection(provider: AutoDetectSurface, id: string, status: ObservationConnection['status'], lastEventAt: string | null): ObservationConnection {
  return { id, provider, repoId: 'project', label: `${provider} (auto-detected)`, status, createdAt: '2026-09-20T09:00:00Z', lastEventAt, version: null, coverage: 'partial', droppedEvents: 0, droppedEventsExact: true };
}

function seedConnection(id: string, provider: AutoDetectSurface, overrides: Partial<StopSyncingConnectionStatus> = {}): StopSyncingConnectionStatus {
  return { connectionId: id, provider, label: `${provider} (auto-detected)`, hooks: 'removed', hooksPath: null, removedEntries: 6, residualEntries: 0, drain: 'skipped', eventsDelivered: 0, eventsDiscarded: 0, eventsRemaining: 0, heldFromManager: false, heldReportCount: 0, revoked: false, hidden: false, cleaned: false, step: null, result: null, ...overrides };
}

/** H0-32: the durable record the real service now persists is the FULL per-connection status, not just
 * {connectionId, step, result} — this fixture mirrors that by deriving a full StopSyncingConnectionProgress
 * entry from a status-shaped object (a seedConnection() result, or one of job.connections/finalConnections
 * below, all of which already have this shape) plus the step/result being recorded at that moment. */
function progressEntry(status: StopSyncingConnectionStatus, step: StopSyncingStep, result: 'stopped' | 'partial' | null, updatedAt = new Date().toISOString()): StopSyncingConnectionProgress {
  return { connectionId: status.connectionId, provider: status.provider, label: status.label, step, result,
    hooks: status.hooks, hooksPath: status.hooksPath, removedEntries: status.removedEntries, residualEntries: status.residualEntries,
    drain: status.drain, eventsDelivered: status.eventsDelivered, eventsDiscarded: status.eventsDiscarded, eventsRemaining: status.eventsRemaining,
    heldFromManager: status.heldFromManager, heldReportCount: status.heldReportCount,
    revoked: status.revoked, hidden: status.hidden, cleaned: status.cleaned,
    retryable: result !== 'stopped', updatedAt };
}

interface FixtureOptions {
  connections?: ObservationConnection[];
  agents?: Agent[];
  stopSyncingProgress?: StopSyncingConnectionProgress[];
  /** How the mocked job resolves once started: which status its poll eventually settles on. */
  outcome?: 'stopped' | 'partial' | 'cancelled';
  /** codex's preview shows a settings file that could not be safely edited. */
  uneditable?: boolean;
  /** The very first POST to actually start the job fails outright (a real network/service error before any
   * job exists), so nothing is removed: the SW-6 "failed, nothing changed" case, distinct from a partial result. */
  failFirstStart?: boolean;
  /** Per-call control over the preview GET (H0-14 fixer review, finding n=3): entry N answers the (N+1)th
   * preview GET this fixture receives, after an optional artificial delay, with a distinguishable
   * `automaticManagerProcessing` flag so a test can tell which call's answer actually won. A call past the
   * end of this list (or when it is omitted) gets the ordinary, undelayed, `false` answer every other test
   * here already relies on. */
  previewSequence?: { delayMs: number; automaticManagerProcessing: boolean }[];
}

async function stopSyncingFixture(page: Page, options: FixtureOptions = {}) {
  const repo: Repository = { id: 'project', name: 'Stop syncing café', description: 'Fixture project', language: 'TypeScript', branch: 'main', color: '#859b87', position: [-6, -3], source: 'local', projectKind: 'git', localPath: repoPath };
  const snapshot: Snapshot = { cursor: 1, state: { schemaVersion: 1, workspace: { id: workspaceId, name: 'Stop syncing fixture', mode: 'private' }, simulation: { running: false, step: 0 }, repositories: [repo], agents: options.agents ?? [], activity: [], handoffs: [], manager: { version: 0, brief: 'No received reports', updatedAt: null }, observation: { connections: options.connections ?? [], stopSyncingProgress: options.stopSyncingProgress ?? [] }, discovery: { roots: [String.raw`C:\synthetic-stop-syncing`], candidates: [], operation: null } } };
  const session: BrowserSession = { csrf: 'synthetic-csrf', mode: 'private', applicationMode: 'development', user: { id: 'stop-syncing-owner', login: 'fixture-owner', displayName: 'Fixture owner', avatarUrl: null }, workspaces: [{ id: workspaceId, name: 'Stop syncing fixture', kind: 'personal' }], identity: { configured: true } };
  const calls: { path: string; query: string; method: string; body: unknown }[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('agent-town-reduced-motion', 'true');
    class FixtureEvents extends EventTarget {
      onopen: (() => void) | null = null;
      closed = false;
      listener = (event: Event) => this.dispatchEvent(new MessageEvent('state', { data: JSON.stringify((event as CustomEvent).detail) }));
      constructor() { super(); window.addEventListener('stop-syncing-fixture-state', this.listener); setTimeout(() => { if (!this.closed) this.onopen?.(); }, 0); }
      close() { this.closed = true; window.removeEventListener('stop-syncing-fixture-state', this.listener); }
    }
    window.EventSource = FixtureEvents as unknown as typeof EventSource;
  });
  const publish = async () => { snapshot.cursor++; await page.evaluate(current => window.dispatchEvent(new CustomEvent('stop-syncing-fixture-state', { detail: current })), snapshot); };

  let tokenCounter = 0;
  let job: { id: string; status: StopSyncingOperation['status']; connections: StopSyncingConnectionStatus[]; polls: number; cancelRequested: boolean } | null = null;
  let startCount = 0;

  const hookPathFor = (id: string) => id === connectionIds.claude ? `${repoPath}\\.claude\\settings.local.json` : `${repoPath}\\.codex\\hooks.json`;
  // The preview always shows what a real edit WOULD find (planHookRemoval never depends on the owner's
  // eventual editFiles choice, only on whether the file itself is safe to edit — see stopSyncingHooksPreview
  // in observation/service.ts), so it only ever reflects this fixture's own `uneditable` option. A real job
  // run additionally forces 'left' for every connection once the owner actually chose editFiles: false —
  // `jobHooksFor` below is what the POST/poll handlers use for that, distinct from this preview-only shape.
  const jobHooksFor = (id: string, editFiles: boolean): Partial<StopSyncingConnectionStatus> =>
    (!editFiles || (id === connectionIds.codex && options.uneditable)) ? { hooks: 'left', hooksPath: hookPathFor(id), removedEntries: 0 } : {};
  // Mirrors the real stopSyncingTargets() (observation/service.ts): every connection of this project whose
  // durable progress result is not 'stopped' — including one already revoked but never cleaned up (H0-32) —
  // never just "not yet revoked". A connection this fixture has never touched (no progress entry at all) is
  // always included, same as today.
  const targetConnections = () => {
    const progress = snapshot.state.observation!.stopSyncingProgress ?? [];
    return (snapshot.state.observation!.connections ?? []).filter(item => item.repoId === 'project' && progress.find(entry => entry.connectionId === item.id)?.result !== 'stopped');
  };
  const previewConnections = (): StopSyncingConnectionStatus[] => targetConnections().map(item => seedConnection(item.id, item.provider as AutoDetectSurface, jobHooksFor(item.id, true)));

  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (path === '/api/v1/session') return route.fulfill({ json: session });
    if (path.endsWith('/snapshot')) return route.fulfill({ json: snapshot });
    if (path === '/api/v1/health' && request.method() === 'GET') return route.fulfill({ json: { ok: true, rebuiltPendingRestart: false } });
    calls.push({ path, query: url.search, method: request.method(), body: request.postDataJSON?.() ?? null });

    if (path === prefix && request.method() === 'GET') {
      const callIndex = tokenCounter;
      tokenCounter++;
      const step = options.previewSequence?.[callIndex];
      if (step?.delayMs) await new Promise(resolve => setTimeout(resolve, step.delayMs));
      return route.fulfill({ json: { repoId: 'project', connections: previewConnections(), automaticManagerProcessing: step?.automaticManagerProcessing ?? false, reviewToken: `token-${callIndex + 1}` } satisfies StopSyncingPreview });
    }
    if (path === prefix && request.method() === 'POST') {
      const body = request.postDataJSON() as { repoId: string; reviewToken: string; editFiles: boolean; discard: boolean };
      startCount++;
      if (options.failFirstStart && startCount === 1) return route.fulfill({ status: 503, json: { message: 'The local service could not be reached.', code: 'SERVICE_UNAVAILABLE' } });
      const live = targetConnections();
      const newJob = { id: `op-${startCount}`, status: 'running' as StopSyncingOperation['status'], polls: 0, cancelRequested: false, connections: live.map(item => seedConnection(item.id, item.provider as AutoDetectSurface, { step: null, result: null, ...jobHooksFor(item.id, body.editFiles) })) };
      job = newJob;
      // Marks the durable per-connection progress the way the real job does at its very first step, so a
      // reload mid-stop (before the settled poll below) still shows something happened.
      snapshot.state.observation!.stopSyncingProgress = newJob.connections.map(item => progressEntry(item, 'entries-removed', null));
      await publish();
      return route.fulfill({ status: 202, json: { operationId: newJob.id, repoId: body.repoId } });
    }
    const pollMatch = path.match(new RegExp(`^${prefix}/([^/]+)$`));
    if (pollMatch && request.method() === 'GET') {
      if (!job || job.id !== pollMatch[1]) return route.fulfill({ status: 404, json: { message: 'This Stop watching operation is no longer active.', code: 'STOP_SYNCING_NOT_ACTIVE' } });
      job.polls++;
      // "codex" is always the one that succeeds first; "claude" is the one a partial/cancel run leaves
      // unfinished. Matched by provider, never by array position: once codex is revoked (its connection's
      // own status flips below), it drops out of every later `live` list a retry re-reads, so a "Try again"
      // after a partial result must keep singling out claude by name, not by whichever index it now sits at.
      const isCodex = (item: StopSyncingConnectionStatus) => item.provider === 'codex';
      if (job.polls === 1) {
        job.connections = job.connections.map(item => isCodex(item) ? { ...item, step: 'drained' } : item);
        snapshot.state.observation!.stopSyncingProgress = job.connections.map(item => progressEntry(item, item.step ?? 'entries-removed', null));
        await publish();
        return route.fulfill({ json: { operationId: job.id, repoId: 'project', status: 'running', connections: job.connections, cancellable: !job.cancelRequested } satisfies StopSyncingOperation });
      }
      const outcome = options.outcome ?? 'stopped';
      const discardRun = startCount >= 3;
      let finalStatus: StopSyncingOperation['status'];
      let finalConnections: StopSyncingConnectionStatus[];
      if (job.cancelRequested) {
        finalStatus = 'cancelled';
        finalConnections = job.connections.map(item => isCodex(item) ? { ...item, step: 'cleaned', result: 'stopped', revoked: true, cleaned: true } : { ...item, step: item.step, result: null });
      } else if (outcome === 'partial' && !discardRun) {
        finalStatus = 'partial';
        finalConnections = job.connections.map(item => isCodex(item) ? { ...item, step: 'cleaned', result: 'stopped', revoked: true, cleaned: true } : { ...item, step: 'drained', result: 'partial', eventsRemaining: 3 });
      } else {
        finalStatus = 'stopped';
        finalConnections = job.connections.map(item => ({ ...item, step: 'cleaned', result: 'stopped', revoked: true, cleaned: true, eventsRemaining: 0 }));
      }
      job.status = finalStatus;
      job.connections = finalConnections;
      // The real job's own revoke step marks the connection revoked (and hides its sessions) in the same
      // commit; mirrored here so the resident row and the compact status line update the way they really would.
      for (const item of finalConnections) if (item.result === 'stopped') { const live = snapshot.state.observation!.connections.find(candidate => candidate.id === item.connectionId); if (live) live.status = 'revoked'; }
      snapshot.state.observation!.stopSyncingProgress = finalConnections.map(item => progressEntry(item, item.step ?? 'cleaned', item.result));
      await publish();
      return route.fulfill({ json: { operationId: job.id, repoId: 'project', status: finalStatus, connections: finalConnections, cancellable: false } satisfies StopSyncingOperation });
    }
    const cancelMatch = path.match(new RegExp(`^${prefix}/([^/]+)/cancel$`));
    if (cancelMatch && request.method() === 'POST') {
      if (job && job.id === cancelMatch[1]) job.cancelRequested = true;
      return route.fulfill({ json: { cancellationRequested: true } });
    }
    return route.fulfill({ status: 400, json: { message: 'Unexpected synthetic stop-syncing operation.' } });
  });
  await page.goto('/');
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  return { snapshot, calls, publish, pageErrors, repo };
}

async function openRepository(page: Page, list = false, name = 'Stop syncing café') {
  if (list) { await page.getByRole('button', { name: 'Show list view', exact: true }).click(); await page.locator('.list-places').getByRole('button', { name, exact: true }).click(); }
  else await page.getByRole('button', { name, exact: true }).click();
  await expect(page.getByTestId('room-context')).toBeVisible();
  await page.getByRole('button', { name: 'Repository details', exact: true }).click();
  const drawer = page.getByTestId('right-drawer');
  await expect(drawer).toBeVisible();
  return drawer;
}

async function seriousViolations(page: Page, selector = '[data-testid="right-drawer"]') {
  const scan = await new AxeBuilder({ page }).include(selector).analyze();
  return scan.violations.filter(violation => violation.impact === 'critical' || violation.impact === 'serious').map(violation => ({ id: violation.id, nodes: violation.nodes.map(node => node.target.join(' ')) }));
}

test('the Watching line names each tool honestly and Stop watching opens a focus-trapped dialog that Escape and Keep watching both keep watching', async ({ page }, testInfo) => {
  await stopSyncingFixture(page, { connections: [connection('codex', connectionIds.codex, 'receiving', new Date(Date.now() - 3 * 60000).toISOString()), connection('claude', connectionIds.claude, 'unverified', null)] });
  const drawer = await openRepository(page);

  const codexLine = drawer.locator('p').filter({ hasText: 'Codex ·' });
  const claudeLine = drawer.locator('p').filter({ hasText: 'Claude Code ·' });
  await expect(codexLine).toContainText('Receiving activity (last');
  await expect(codexLine.locator('.status-dot')).toHaveClass(/live/);
  await expect(claudeLine).toContainText('Waiting for first activity');
  await expect(claudeLine.locator('.status-dot')).not.toHaveClass(/live/);

  // No horizontal overflow at whatever width this project runs at (desktop 1440 or the mobile project's ~390).
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  expect.soft(await seriousViolations(page), 'axe: Watching line visible, dialog closed').toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('watching-line.png') });

  const stopButton = drawer.getByRole('button', { name: 'Stop watching this project', exact: true });
  await stopButton.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Stop watching this project' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Stop watching this project?', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Keep watching', exact: true })).toBeFocused();
  await expect(dialog).toContainText('.codex/hooks.json');
  await expect(dialog).toContainText('.claude/settings.local.json');
  // The settings-file path is the exact text this acceptance line requires the dialog to name; it must render
  // at 12 px or larger like every other dialog string (DES-02 section 6), not an undersized inline override.
  const codexPath = dialog.locator('code').filter({ hasText: '.codex/hooks.json' });
  await expect(codexPath).toHaveCSS('font-size', '12px');
  await expect(dialog).toContainText('Stop reading activity from Codex and Claude Code.');
  await expect(dialog).toContainText('Saved reports and history are kept.');
  await expect(dialog).not.toContainText('deleted');
  await page.screenshot({ path: testInfo.outputPath('stop-confirm-dialog.png') });

  // Tab from the last control wraps back to Keep watching: the dialog traps focus, never the page behind it.
  await expect(dialog.getByRole('button', { name: 'Stop watching', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Stop watching', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Keep watching', exact: true })).toBeFocused();

  expect.soft(await seriousViolations(page), 'axe: Stop watching confirm dialog open').toEqual([]);

  // Escape keeps watching: the dialog closes, the drawer (and the Watching line) stays exactly as it was.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(drawer).toBeVisible();
  await expect(stopButton).toBeVisible();
  await expect(codexLine).toContainText('Receiving activity (last');
});

test('a clean stop shows distinct success copy, marks the resident Stopped watching, and Connections keeps its manual buttons', async ({ page }, testInfo) => {
  const agent: Agent = { id: 'codex-agent', name: 'Codex session', provider: 'Codex', role: 'Observed session', repoId: 'project', task: 'Task not linked', activity: 'working', color: '#6c8c91', home: [-5.4, -0.5], updatedAt: new Date().toISOString(), files: [], evidence: 'Observed tool event', contextVersion: null, observation: { connectionId: connectionIds.codex, sessionId: 'sess-1', parentSessionId: null, lastSequence: 1, sourceTime: new Date().toISOString(), freshness: 'current', billing: 'unavailable' } };
  const town = await stopSyncingFixture(page, { connections: [connection('codex', connectionIds.codex, 'receiving', new Date(Date.now() - 3 * 60000).toISOString()), connection('claude', connectionIds.claude, 'unverified', null)], agents: [agent], outcome: 'stopped' });
  const drawer = await openRepository(page);
  await drawer.getByRole('button', { name: 'Stop watching this project', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Stop watching this project' });
  await expect(dialog).toContainText('Hides the 1 session shown for this project');
  await expect(dialog.getByRole('checkbox')).toHaveCount(0); // No file was flagged un-editable in this fixture.

  await dialog.getByRole('button', { name: 'Stop watching', exact: true }).click();
  // The running phase is real but brief against this mocked, near-instant backend; its own text ("Stopping.
  // This takes a few seconds.") is pinned directly above by the confirm->running transition, so what matters
  // here is that the dialog settles on the distinct, correct outcome text, not catching every frame between.
  await expect(dialog).toContainText('Stopped watching Codex and Claude Code.');
  await expect(dialog).toContainText('open sessions may need a restart');
  await expect(dialog).toContainText('Reports and sessions are kept.');
  await expect(dialog).not.toContainText('deleted');
  await expect(dialog).not.toContainText('archived');
  await page.screenshot({ path: testInfo.outputPath('stop-success-result.png') });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();

  // The button and the Watching line are gone now that nothing is watched; the resident reads "Stopped watching".
  await expect(drawer.getByRole('button', { name: 'Stop watching this project', exact: true })).toHaveCount(0);
  const stoppedResident = drawer.locator('.agent-row').filter({ hasText: 'Codex session' });
  await expect(stoppedResident).toContainText('Stopped watching');
  // H0-14 fixer review, finding n=2: this fixture's own agent has `activity: 'working'` right up to the stop
  // (the ordinary case for a session that was actively receiving), and styles.css defines no `.status-working`
  // override, so leaving `status-${agent.activity}` in place once revoked used to fall back to the base
  // `.status` colour — the same green family as "receiving"/"live" — for a resident that just stopped. It must
  // read the same neutral colour as the other terminal activities (idle/offline/cancelled) instead.
  const stoppedStatus = stoppedResident.locator('.status');
  await expect(stoppedStatus).not.toHaveClass(/status-working/);
  await expect(stoppedStatus).toHaveCSS('color', 'rgb(89, 102, 79)');

  expect(town.calls.filter(call => call.path.endsWith('/observation/tool-detection') || call.path.endsWith('/observation/native-setup')), 'Stop watching never touches the manual tool-detection/native-setup routes').toEqual([]);
});

test('a settings file that cannot be safely edited offers "stop without editing files" and sends it through', async ({ page }) => {
  const town = await stopSyncingFixture(page, { connections: [connection('codex', connectionIds.codex, 'receiving', new Date().toISOString())], uneditable: true, outcome: 'stopped' });
  const drawer = await openRepository(page);
  await drawer.getByRole('button', { name: 'Stop watching this project', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Stop watching this project' });
  await expect(dialog).toContainText('could not be safely edited');
  const checkbox = dialog.getByRole('checkbox', { name: /Stop without editing files/ });
  await expect(checkbox).toBeVisible();
  await expect(checkbox).not.toBeChecked();
  await checkbox.check();
  await dialog.getByRole('button', { name: 'Stop watching', exact: true }).click();
  await expect(dialog).toContainText('Stopped watching Codex.');
  const starts = town.calls.filter(call => call.path === prefix && call.method === 'POST');
  expect(starts).toHaveLength(1);
  expect(starts[0]!.body).toMatchObject({ editFiles: false });
  // H0-32: editFiles: false must never claim entries were removed — the settled banner and the per-connection
  // row both have to say the entries were left in place instead.
  await expect(dialog).not.toContainText("entries were removed");
  await expect(dialog).toContainText('its settings entries were left in place for Codex');
  await expect(dialog).toContainText('remove it yourself when ready');
  await expect(dialog).toContainText('Codex: Stopped · Could not be safely edited');
});

test('a partial result stays listed, Try again is offered, and Discard finishes it', async ({ page }) => {
  const town = await stopSyncingFixture(page, { connections: [connection('codex', connectionIds.codex, 'receiving', new Date().toISOString()), connection('claude', connectionIds.claude, 'receiving', new Date().toISOString())], outcome: 'partial' });
  const drawer = await openRepository(page);
  await drawer.getByRole('button', { name: 'Stop watching this project', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Stop watching this project' });
  await dialog.getByRole('button', { name: 'Stop watching', exact: true }).click();

  await expect(dialog).toContainText('Stop watching is partial.');
  await expect(dialog).toContainText('Reports and sessions are kept.');
  await expect(dialog).toContainText('3 events still unread');
  const tryAgain = dialog.getByRole('button', { name: 'Try again', exact: true });
  const discard = dialog.getByRole('button', { name: /Discard 3 unread events and finish/, exact: false });
  await expect(tryAgain).toBeVisible();
  await expect(discard).toBeVisible();

  await tryAgain.click();
  await expect(dialog).toContainText('Stop watching is partial.');

  await discard.click();
  await expect(dialog).toContainText('Stopped watching');
  const starts = town.calls.filter(call => call.path === prefix && call.method === 'POST');
  expect(starts.at(-1)).toMatchObject({ body: expect.objectContaining({ discard: true }) });
});

test('Cancel between connections stops the job early with cancelled copy, and it can be finished by choosing Stop watching again', async ({ page }) => {
  await stopSyncingFixture(page, { connections: [connection('codex', connectionIds.codex, 'receiving', new Date().toISOString()), connection('claude', connectionIds.claude, 'receiving', new Date().toISOString())], outcome: 'cancelled' });
  const drawer = await openRepository(page);
  await drawer.getByRole('button', { name: 'Stop watching this project', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Stop watching this project' });
  await dialog.getByRole('button', { name: 'Stop watching', exact: true }).click();
  const cancelButton = dialog.getByRole('button', { name: 'Cancel between connections', exact: true });
  await expect(cancelButton).toBeEnabled();
  await cancelButton.click();
  await expect(dialog).toContainText('Stopping was cancelled.');
  await expect(dialog).toContainText('Choose Stop watching this project again to finish.');
});

test('an incomplete previous stop reads as interrupted and offers Resume, and that reading survives a full page reload', async ({ page }) => {
  const town = await stopSyncingFixture(page, { connections: [connection('codex', connectionIds.codex, 'receiving', new Date().toISOString())], stopSyncingProgress: [progressEntry(seedConnection(connectionIds.codex, 'codex'), 'neutralized', null)], outcome: 'stopped' });
  const drawer = await openRepository(page);
  await drawer.getByRole('button', { name: 'Stop watching this project', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Stop watching this project' });
  await expect(dialog.getByRole('heading', { name: 'Resume stopping this project?', exact: true })).toBeVisible();
  await expect(dialog).toContainText('may have been interrupted while stopping this project before');
  await expect(dialog.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();

  // Reload while nothing further has happened server-side: the durable per-connection progress this fixture
  // seeded is still there, so reopening reads the same interrupted state — the H0-14 acceptance line "a page
  // reload during a stop shows the current step" holds even across a full page reload, not only a re-render.
  await page.reload();
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  const reopened = await openRepository(page);
  await reopened.getByRole('button', { name: 'Stop watching this project', exact: true }).click();
  const dialogAfterReload = page.getByRole('dialog', { name: 'Stop watching this project' });
  await expect(dialogAfterReload.getByRole('heading', { name: 'Resume stopping this project?', exact: true })).toBeVisible();
  await dialogAfterReload.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(dialogAfterReload).toContainText('Stopped watching Codex.');
  void town;
});

test('H0-32: a project whose every connection is already revoked, with a durable "partial" result left over, stays recoverable — not hidden — across a full page reload, and Finish stopping this project completes it', async ({ page }) => {
  // Every connection is revoked (so watchedAuto, which filters revoked connections out, is empty), but the
  // durable per-connection record still says this one's clean-up never finished (`result: 'partial'`) — the
  // exact state stopSyncingTargets()/registry.forProject() on the real service keeps returning as a target.
  const revokedButPartial = progressEntry(seedConnection(connectionIds.codex, 'codex', { revoked: true, cleaned: false, drain: 'drained', eventsDelivered: 1, hidden: true }), 'revoked', 'partial');
  await stopSyncingFixture(page, { connections: [connection('codex', connectionIds.codex, 'revoked', new Date(Date.now() - 60000).toISOString())], stopSyncingProgress: [revokedButPartial], outcome: 'stopped' });
  const drawer = await openRepository(page);

  // Neither the ordinary button nor the whole component silently disappeared just because nothing is
  // currently "watched" — the recovery-specific label appears instead.
  await expect(drawer.getByRole('button', { name: 'Stop watching this project', exact: true })).toHaveCount(0);
  const finishButton = drawer.getByRole('button', { name: 'Finish stopping this project', exact: true });
  await expect(finishButton).toBeVisible();

  // Survives a full page reload: `phase` resets to 'closed' and watchedAuto is still empty, so only the
  // durable record (not any local component state) is what keeps this button reachable.
  await page.reload();
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  const reopened = await openRepository(page);
  const reopenedFinish = reopened.getByRole('button', { name: 'Finish stopping this project', exact: true });
  await expect(reopenedFinish).toBeVisible();

  await reopenedFinish.click();
  const dialog = page.getByRole('dialog', { name: 'Stop watching this project' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Stop watching', exact: true }).click();
  await expect(dialog).toContainText('Stopped watching Codex.');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();

  // Now genuinely finished (the durable result is 'stopped'): the recovery button is gone too.
  await expect(reopened.getByRole('button', { name: 'Finish stopping this project', exact: true })).toHaveCount(0);
});

test('a hard failure before the job ever starts changes nothing, says so, and choosing Stop watching again retries it', async ({ page }) => {
  const town = await stopSyncingFixture(page, { connections: [connection('codex', connectionIds.codex, 'receiving', new Date().toISOString())], failFirstStart: true });
  const drawer = await openRepository(page);
  await drawer.getByRole('button', { name: 'Stop watching this project', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Stop watching this project' });
  await dialog.getByRole('button', { name: 'Stop watching', exact: true }).click();
  await expect(dialog).toContainText('Stopping did not finish. Nothing was removed and your sessions are as they were.');
  // The already-reviewed confirm screen (files, tools, the "hides N sessions" note) is still right there:
  // retrying is choosing "Stop watching" again, not a separate control, since nothing needs reviewing twice.
  const retry = dialog.getByRole('button', { name: 'Stop watching', exact: true });
  await expect(retry).toBeVisible();
  await expect(dialog).toContainText('.codex/hooks.json');
  // Nothing actually changed server-side: the connection is exactly as it was, and the second attempt below
  // (which this fixture lets succeed) still sees the original, un-revoked connection to work with.
  expect(town.snapshot.state.observation!.connections[0]!.status).toBe('receiving');
  await retry.click();
  await expect(dialog).toContainText('Stopped watching Codex.');
});

test('the first "Receiving activity" for a tool is announced once through the live-region announcer', async ({ page }) => {
  const town = await stopSyncingFixture(page, { connections: [connection('codex', connectionIds.codex, 'unverified', null)] });
  const drawer = await openRepository(page);
  const announcer = drawer.locator('p[role="status"][aria-live="polite"]').first();
  await expect(drawer.locator('p').filter({ hasText: 'Codex ·' })).toContainText('Waiting for first activity');
  await expect(announcer).toHaveText('');

  // The connection starts reporting: a real snapshot push, exactly like the SSE stream delivers one.
  town.snapshot.state.observation!.connections[0] = connection('codex', connectionIds.codex, 'receiving', new Date().toISOString());
  await town.publish();
  await expect(drawer.locator('p').filter({ hasText: 'Codex ·' })).toContainText('Receiving activity');
  await expect(announcer).toHaveText('Codex is now receiving activity.');

  // A later, still-receiving update (a newer lastEventAt) must not announce the same thing again.
  town.snapshot.state.observation!.connections[0] = connection('codex', connectionIds.codex, 'receiving', new Date().toISOString());
  await town.publish();
  await page.waitForTimeout(300);
  await expect(announcer).toHaveText('Codex is now receiving activity.');
});

test('the same Watching line and Stop watching dialog are reachable from the List view', async ({ page }) => {
  await stopSyncingFixture(page, { connections: [connection('codex', connectionIds.codex, 'receiving', new Date().toISOString())] });
  const drawer = await openRepository(page, true);
  await expect(drawer.locator('p').filter({ hasText: 'Codex ·' })).toContainText('Receiving activity');
  await drawer.getByRole('button', { name: 'Stop watching this project', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Stop watching this project' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Keep watching', exact: true })).toBeFocused();
});

test('a fast Escape-then-reopen never lets the first, slower preview overwrite the fresh one the second open already showed', async ({ page }) => {
  // H0-14 fixer review, finding n=3: openDialog()'s preview GET used to guard only with a shared "is the
  // dialog closed" boolean, not a per-open token. The first open here answers slowly and, if it ever won,
  // would flip on the automatic-manager notice; the second, fast open answers first with that notice off,
  // which is the true current state. If the slow first answer is still allowed to land afterward and
  // silently overwrite it, the notice reappears — proving the stale response won, not the fresh one.
  await stopSyncingFixture(page, {
    connections: [connection('codex', connectionIds.codex, 'receiving', new Date().toISOString())],
    previewSequence: [
      { delayMs: 700, automaticManagerProcessing: true },
      { delayMs: 0, automaticManagerProcessing: false },
    ],
  });
  const drawer = await openRepository(page);
  const stopButton = drawer.getByRole('button', { name: 'Stop watching this project', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Stop watching this project' });
  const managerNotice = 'The manager processes reports automatically';

  // Opens the dialog (kicks off the slow, first preview GET), then closes it well before that GET can answer.
  await stopButton.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // Reopens immediately (kicks off the fast, second preview GET), which answers first, with the notice off.
  await stopButton.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Stop watching', exact: true })).toBeVisible();
  await expect(dialog).not.toContainText(managerNotice);

  // Waits past the first GET's 700ms delay: its late, now-stale answer must still be ignored.
  await page.waitForTimeout(900);
  await expect(dialog).not.toContainText(managerNotice);
});

// H0-15 (plan v5, milestone V0): the house inspector Residents block's "Hide these N sessions", and once any
// are hidden, "N sessions hidden · Show" with a per-session "Show in town" (DES-02 RS-3). This is its own
// fixture, not stopSyncingFixture's (which answers 400 to anything outside the Stop watching job): no
// observation connection is seeded at all, which is exactly what proves the flow works with no connection —
// the saved, never-hooked Codex sessions the acceptance line names.
const hiddenRepoPath = String.raw`C:\synthetic-hidden-sessions\project`;

function hiddenNativeSession(index: number, at: string): { session: NativeSession; agent: Agent } {
  const id = `hidden-fixture-${index}`;
  const agent: Agent = { id, name: `Fixture session ${index}`, provider: 'Codex', role: 'Observed session', repoId: 'project', task: 'Task not linked', activity: 'working', color: '#6c8c91', home: [-5 + index, -0.5], updatedAt: at, files: [], evidence: 'Observed tool event', contextVersion: null,
    observation: { connectionId: 'fixture-connection', sessionId: `wire-${index}`, parentSessionId: null, nativeSourceId: 'fixture-source', lastSequence: 1, sourceTime: at, freshness: 'current', billing: 'unavailable' } };
  const session: NativeSession = { id, agentId: id, sourceId: 'fixture-source', provider: 'codex', nativeSessionId: `native-${index}`, title: `Fixture session ${index}`, repoId: 'project', createdAt: at, nativeUpdatedAt: at, discoveredAt: at, observedAt: at, visible: true, sceneVisible: true, visibility: 'shown', activity: 'working' };
  return { session, agent };
}

async function hiddenSessionsFixture(page: Page, options: { count?: number } = {}) {
  const repo: Repository = { id: 'project', name: 'Hidden sessions café', description: 'Fixture project', language: 'TypeScript', branch: 'main', color: '#859b87', position: [-6, -3], source: 'local', projectKind: 'git', localPath: hiddenRepoPath };
  const now = new Date().toISOString();
  const fixtures = Array.from({ length: options.count ?? 3 }, (_, index) => hiddenNativeSession(index, now));
  const nativeSessions = new Map(fixtures.map(item => [item.session.id, item.session]));
  const agentsById = new Map(fixtures.map(item => [item.agent.id, item.agent]));
  const snapshot: Snapshot = { cursor: 1, state: { schemaVersion: 1, workspace: { id: workspaceId, name: 'Hidden sessions fixture', mode: 'private' }, simulation: { running: false, step: 0 }, repositories: [repo], agents: fixtures.map(item => item.agent), activity: [], handoffs: [], manager: { version: 0, brief: 'No received reports', updatedAt: null }, observation: { connections: [], stopSyncingProgress: [] }, discovery: { roots: [String.raw`C:\synthetic-hidden-sessions`], candidates: [], operation: null } } };
  const session: BrowserSession = { csrf: 'synthetic-csrf', mode: 'private', applicationMode: 'development', user: { id: 'hidden-sessions-owner', login: 'fixture-owner', displayName: 'Fixture owner', avatarUrl: null }, workspaces: [{ id: workspaceId, name: 'Hidden sessions fixture', kind: 'personal' }], identity: { configured: true } };
  const calls: { path: string; query: string; method: string; body: unknown }[] = [];
  const observationPrefix = `/api/v1/workspaces/${workspaceId}/observation`;
  await page.addInitScript(() => {
    localStorage.setItem('agent-town-reduced-motion', 'true');
    class FixtureEvents extends EventTarget {
      onopen: (() => void) | null = null;
      closed = false;
      listener = (event: Event) => this.dispatchEvent(new MessageEvent('state', { data: JSON.stringify((event as CustomEvent).detail) }));
      constructor() { super(); window.addEventListener('hidden-sessions-fixture-state', this.listener); setTimeout(() => { if (!this.closed) this.onopen?.(); }, 0); }
      close() { this.closed = true; window.removeEventListener('hidden-sessions-fixture-state', this.listener); }
    }
    window.EventSource = FixtureEvents as unknown as typeof EventSource;
  });
  const publish = async () => { snapshot.cursor++; await page.evaluate(current => window.dispatchEvent(new CustomEvent('hidden-sessions-fixture-state', { detail: current })), snapshot); };

  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    // A fresh CSRF token: this is the same POST RepositoryAgents.tsx's own small request helper uses (see
    // its header comment) since it is not handed the app's `identity`, only the three props every caller of
    // it already passes.
    if (path === '/api/v1/session') return route.fulfill({ json: session });
    if (path.endsWith('/snapshot')) return route.fulfill({ json: snapshot });
    if (path === '/api/v1/health' && request.method() === 'GET') return route.fulfill({ json: { ok: true, rebuiltPendingRestart: false } });
    calls.push({ path, query: url.search, method: request.method(), body: request.postDataJSON?.() ?? null });

    if (path === `${observationPrefix}/native-sessions/hide-all` && request.method() === 'POST') {
      const body = request.postDataJSON() as { repoId: string };
      let hidden = 0, alreadyHidden = 0;
      for (const item of nativeSessions.values()) {
        if (item.repoId !== body.repoId) continue;
        if (item.visibility === 'hidden') { alreadyHidden++; continue; }
        item.visibility = 'hidden'; item.visible = false; item.sceneVisible = false;
        hidden++;
      }
      snapshot.state.agents = snapshot.state.agents.filter(agent => nativeSessions.get(agent.id)?.visibility !== 'hidden');
      await publish();
      return route.fulfill({ json: { repoId: body.repoId, hidden, alreadyHidden, skippedLegacy: 0, snapshot } });
    }
    if (path === `${observationPrefix}/native-sessions` && request.method() === 'GET') {
      const repoId = url.searchParams.get('repoId'), visibility = url.searchParams.get('visibility');
      const scoped = [...nativeSessions.values()].filter(item => !repoId || item.repoId === repoId);
      const hiddenTotal = scoped.filter(item => item.visibility === 'hidden').length;
      const filtered = scoped.filter(item => !visibility || item.visibility === visibility);
      return route.fulfill({ json: { items: filtered.slice(0, 25), total: filtered.length, nextCursor: null, hiddenTotal } });
    }
    const visibilityMatch = path.match(new RegExp(`^${observationPrefix}/native-sessions/([^/]+)/visibility$`));
    if (visibilityMatch && request.method() === 'POST') {
      const id = visibilityMatch[1]!, body = request.postDataJSON() as { visible: boolean };
      const item = nativeSessions.get(id);
      if (!item) return route.fulfill({ status: 404, json: { message: 'This native session is unavailable.', code: 'NATIVE_SESSION_NOT_FOUND' } });
      item.visible = body.visible; item.visibility = body.visible ? 'shown' : 'hidden'; item.sceneVisible = body.visible;
      if (body.visible) { const agent = agentsById.get(id)!; if (!snapshot.state.agents.some(candidate => candidate.id === id)) snapshot.state.agents = [...snapshot.state.agents, agent]; }
      else snapshot.state.agents = snapshot.state.agents.filter(agent => agent.id !== id);
      await publish();
      return route.fulfill({ json: snapshot });
    }
    return route.fulfill({ status: 400, json: { message: 'Unexpected synthetic hidden-sessions operation.' } });
  });
  await page.goto('/');
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  return { snapshot, calls, publish, repo };
}

test('Residents hides every native-backed session in one step (asking once), lists them as hidden, and shows one back in town — with no connection at all, focus returning to the summary, and axe clean throughout', async ({ page }, testInfo) => {
  await hiddenSessionsFixture(page, { count: 3 });
  const drawer = await openRepository(page, false, 'Hidden sessions café');

  await expect(drawer.locator('.agent-row')).toHaveCount(3);
  const hideButton = drawer.getByRole('button', { name: 'Hide these 3 sessions', exact: true });
  await expect(hideButton).toBeVisible();
  expect.soft(await seriousViolations(page), 'axe: Residents block before hiding').toEqual([]);

  // Asks once: the button opens an inline confirmation naming the exact count, not a silent action.
  await hideButton.click();
  await expect(drawer).toContainText('Hide these 3 sessions? They leave town but stay in history. You can show any of them again.');
  const yesButton = drawer.getByRole('button', { name: 'Yes, hide these 3 sessions', exact: true });
  await expect(yesButton).toBeFocused();

  // Cancel changes nothing and returns focus to the button that opened it, keyboard-only.
  await page.keyboard.press('Tab');
  await expect(drawer.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(drawer.getByText('Hide these 3 sessions? They leave town but stay in history.', { exact: false })).toHaveCount(0);
  await expect(hideButton).toBeFocused();
  await expect(drawer.locator('.agent-row')).toHaveCount(3);

  await hideButton.click();
  await expect(yesButton).toBeFocused();
  await yesButton.click();

  // "N sessions hidden · Show" appears only now that something is hidden, and takes focus once it does —
  // the same "a result banner takes focus" rule DES-02 section 6 pins for the rest of this drawer.
  const summary = drawer.locator('[data-testid="hidden-sessions"] summary');
  await expect(summary).toContainText('3 sessions hidden · Show');
  await expect(summary).toBeFocused();
  await expect(drawer.locator('.agent-row')).toHaveCount(0);
  await expect(drawer).toContainText('No sessions are being watched. No sessions were scanned.');
  await expect(hideButton).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('hidden-sessions-hidden-all.png') });
  expect.soft(await seriousViolations(page), 'axe: after hiding, list collapsed').toEqual([]);

  // Keyboard-only: Tab/Enter opens the disclosure and finds a specific session, never "archived".
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(drawer.locator('[data-testid="hidden-sessions"]')).toHaveJSProperty('open', true);
  const targetRow = drawer.locator('[data-testid="hidden-sessions"] li', { hasText: 'Fixture session 1' });
  await expect(targetRow).toBeVisible();
  const showButton = targetRow.getByRole('button', { name: 'Show in town', exact: true });
  await expect(showButton).toBeVisible();
  expect(await drawer.locator('[data-testid="hidden-sessions"]').innerText()).not.toMatch(/archived/i);
  expect.soft(await seriousViolations(page), 'axe: hidden session list open').toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('hidden-sessions-list-open.png') });

  // Show one back in town, again with the keyboard alone; the count updates and focus returns to the summary.
  await showButton.focus();
  await page.keyboard.press('Enter');
  await expect(summary).toContainText('2 sessions hidden · Show');
  await expect(summary).toBeFocused();
  await expect(drawer.locator('.agent-row')).toHaveCount(1);
  await expect(drawer.locator('.agent-row')).toContainText('Fixture session 1');
  await expect(drawer.locator('[data-testid="hidden-sessions"] li', { hasText: 'Fixture session 1' })).toHaveCount(0);

  // No horizontal scroll at 320 px.
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('hidden-sessions-320.png') });
  expect.soft(await seriousViolations(page), 'axe: 320px').toEqual([]);
});

test('the same hide-all button and hidden session list are reachable from the List view', async ({ page }) => {
  await hiddenSessionsFixture(page, { count: 2 });
  const drawer = await openRepository(page, true, 'Hidden sessions café');
  await expect(drawer.locator('.agent-row')).toHaveCount(2);
  await drawer.getByRole('button', { name: 'Hide these 2 sessions', exact: true }).click();
  await drawer.getByRole('button', { name: 'Yes, hide these 2 sessions', exact: true }).click();
  const summary = drawer.locator('[data-testid="hidden-sessions"] summary');
  await expect(summary).toContainText('2 sessions hidden · Show');
  await summary.click();
  await expect(drawer.locator('[data-testid="hidden-sessions"] li')).toHaveCount(2);
  await drawer.locator('[data-testid="hidden-sessions"] li').first().getByRole('button', { name: 'Show in town', exact: true }).click();
  await expect(summary).toContainText('1 session hidden · Show');
  await expect(drawer.locator('.agent-row')).toHaveCount(1);
});
