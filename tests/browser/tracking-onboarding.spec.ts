import { expect, test, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { AutoDetectSurface, BrowserSession, ObservationConnection, Snapshot, ToolDetectionReviewItem, ToolDetectionStatus, ToolSurface } from '@agent-town/contracts';

// Combined onboarding (LiveTrackingPanel at the top of the Repository details drawer). The service is
// mocked at the API boundary; the UI, drawer, world canvas and axe checks are real.
//
// H0-02 (plan v5, decision D38 / DR-051, D40 / DR-053): every test below used to expect results the moment the section
// was opened, and a review that came pre-ticked. Now connecting a project and opening its house scan nothing, expanding the
// section only shows it, the one button "Check this computer" starts a check, and the review opens with nothing ticked and
// Apply off until the person ticks a tool. The tests were FLIPPED to that behaviour, not loosened: each assertion the old
// behaviour supported is kept and now reached the new way. Tests/browser/houses-first.spec.ts (H0-16) holds the permanent
// "nothing is requested" proof; H0-06 rewrites this whole file later (headline, "Set up anyway", words).
const workspaceId = 'tracking-onboarding';
const repoPath = String.raw`C:\synthetic-onboarding\project`;
const prefix = `/api/v1/workspaces/${workspaceId}/observation/tool-detection`;
const connectionIds: Record<AutoDetectSurface, string> = {
  codex: '5a0d2a6e-6f6a-4a9b-9d3e-0c1f7f2b8a11',
  claude: '8c3b1f5d-2e4a-4c8b-a1d2-7e9f0b6c4d22',
  cursor: '1f7e9c3a-5b6d-4e2f-8a9b-3c4d5e6f7a33',
  'copilot-cli': '9d8c7b6a-5f4e-4d3c-b2a1-0f9e8d7c6b44',
};
const configFile: Record<AutoDetectSurface, string> = { codex: '.codex/hooks.json', claude: '.claude/settings.local.json', cursor: '.cursor/hooks.json', 'copilot-cli': '.github/hooks/agent-town.json' };
const labels: Record<AutoDetectSurface, string> = { codex: 'Codex', claude: 'Claude Code', cursor: 'Cursor', 'copilot-cli': 'Copilot CLI' };
const nextSteps: Record<AutoDetectSurface, string> = {
  codex: 'In Codex, run /hooks in this project and trust the Agent Town commands.',
  claude: 'Claude Code normally reloads this settings file on its own.',
  cursor: 'Cursor normally reloads hooks on its own in a trusted workspace.',
  'copilot-cli': 'Copilot CLI loads hooks when it starts: restart it in this project.',
};

function reviewItem(provider: AutoDetectSurface): ToolDetectionReviewItem {
  const command = `"C:/Program Files/nodejs/node.exe" "C:/projects/Agent/apps/service/dist/hook-bridge.cjs" --config "C:/synthetic-onboarding/data/bridge/${connectionIds[provider]}.json"`;
  const events = provider === 'cursor' ? ['sessionStart', 'sessionEnd', 'stop'] : ['SessionStart', 'SessionEnd', 'Stop'];
  const hooks = Object.fromEntries(events.map(event => [event, provider === 'cursor' ? [{ command: `${command} --event ${event}`, timeout: 5 }] : [{ hooks: [{ type: 'command', command: `${command} --event ${event}`, timeout: 5 }] }]]));
  return { provider, label: labels[provider], connectionId: connectionIds[provider], configPath: `${repoPath}\\${configFile[provider].replaceAll('/', '\\')}`, config: JSON.stringify(provider === 'cursor' ? { version: 1, hooks } : { hooks }, null, 2), nextStep: nextSteps[provider] };
}

const detected: ToolDetectionStatus[] = [
  { provider: 'codex', label: 'Codex', state: 'found', sessionCount: 18, sessionCountExact: true, message: null },
  { provider: 'claude', label: 'Claude Code', state: 'found', sessionCount: 3, sessionCountExact: true, message: null },
  { provider: 'cursor', label: 'Cursor', state: 'no-activity', sessionCount: 0, sessionCountExact: true, message: null },
  { provider: 'copilot-cli', label: 'Copilot CLI', state: 'not-installed', sessionCount: null, sessionCountExact: true, message: 'GitHub Copilot CLI was not found on this machine.' },
];
interface Options { existing?: ObservationConnection[]; detection?: () => { status: number; body: unknown } | undefined; apply?: () => { status: number; body: unknown } | undefined }

async function onboardingFixture(page: Page, options: Options = {}) {
  const snapshot: Snapshot = { cursor: 1, state: { schemaVersion: 1, workspace: { id: workspaceId, name: 'Onboarding fixture', mode: 'private' }, simulation: { running: false, step: 0 }, repositories: [{ id: 'project', name: 'Local project', description: 'Synthetic local project', language: 'TypeScript', branch: 'main', color: '#859b87', position: [-6, -3], source: 'local', localPath: repoPath }], agents: [], activity: [], handoffs: [], manager: { version: 0, brief: 'No received reports', updatedAt: null }, observation: { connections: options.existing ?? [] }, discovery: { roots: [String.raw`C:\synthetic-onboarding`], candidates: [], operation: null } } };
  const session: BrowserSession = { csrf: 'synthetic-csrf', mode: 'private', applicationMode: 'development', user: { id: 'onboarding-owner', login: 'fixture-owner', displayName: 'Fixture owner', avatarUrl: null }, workspaces: [{ id: workspaceId, name: 'Onboarding fixture', kind: 'personal' }], identity: { configured: true } };
  const calls: { path: string; query: string; method: string; body: unknown; idempotency: string | undefined }[] = [], pageErrors: string[] = [], remote: string[] = [];
  const applied = new Map<AutoDetectSurface, ObservationConnection>();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') remote.push(request.url()); });
  await page.addInitScript(() => {
    localStorage.setItem('agent-town-reduced-motion', 'true');
    class FixtureEvents extends EventTarget {
      onopen: (() => void) | null = null;
      closed = false;
      listener = (event: Event) => this.dispatchEvent(new MessageEvent('state', { data: JSON.stringify((event as CustomEvent).detail) }));
      constructor() { super(); window.addEventListener('onboarding-fixture-state', this.listener); setTimeout(() => { if (!this.closed) this.onopen?.(); }, 0); }
      close() { this.closed = true; window.removeEventListener('onboarding-fixture-state', this.listener); }
    }
    window.EventSource = FixtureEvents as unknown as typeof EventSource;
  });
  const publish = async () => { snapshot.cursor++; await page.evaluate(current => window.dispatchEvent(new CustomEvent('onboarding-fixture-state', { detail: current })), snapshot); };
  const liveConnection = (provider: AutoDetectSurface) => snapshot.state.observation!.connections.find(connection => connection.provider === provider && connection.status !== 'revoked');
  const currentTools = (): ToolDetectionStatus[] => detected.map(tool => {
    const saved = applied.get(tool.provider);
    const connection = saved && saved.status !== 'revoked' ? saved : liveConnection(tool.provider);
    if (!connection) return tool;
    return { provider: tool.provider, label: tool.label, state: 'connected', sessionCount: null, sessionCountExact: true, connectionId: connection.id, connectionStatus: connection.status, lastEventAt: connection.lastEventAt, ...(connection.status === 'receiving' ? {} : { nextStep: nextSteps[tool.provider] }), message: null };
  });
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (path === '/api/v1/session') return route.fulfill({ json: session });
    if (path.endsWith('/snapshot')) return route.fulfill({ json: snapshot });
    calls.push({ path, query: url.search, method: request.method(), body: request.postDataJSON(), idempotency: request.headers()['idempotency-key'] });
    // WS3-24's "rebuilt, restart to use it" poll: asked only for a project that has a connection (H0-02), and answered here with nothing to report.
    if (path === '/api/v1/health' && request.method() === 'GET') return route.fulfill({ json: { ok: true, rebuiltPendingRestart: false } });
    if (path === prefix && request.method() === 'GET') {
      const override = options.detection?.();
      if (override) return route.fulfill({ status: override.status, json: override.body });
      return route.fulfill({ json: { repoId: 'project', tools: currentTools() } });
    }
    if (path === `${prefix}/review` && request.method() === 'POST') {
      const body = request.postDataJSON() as { repoId: string; providers: AutoDetectSurface[] };
      const active = snapshot.state.observation!.connections.map(connection => connection.provider as ToolSurface);
      return route.fulfill({ json: { repoId: body.repoId, items: body.providers.map(reviewItem), activeProviders: active } });
    }
    if (path === `${prefix}/apply` && request.method() === 'POST') {
      const override = options.apply?.();
      if (override) return route.fulfill({ status: override.status, json: override.body });
      const body = request.postDataJSON() as { repoId: string; items: { provider: AutoDetectSurface; connectionId: string }[] };
      for (const item of body.items) {
        // First applied tool already received an event; the second is only configured.
        const receiving = applied.size === 0;
        applied.set(item.provider, { id: item.connectionId, provider: item.provider, repoId: body.repoId, label: `${labels[item.provider]} (auto-detected)`, status: receiving ? 'receiving' : 'unverified', createdAt: new Date().toISOString(), lastEventAt: receiving ? new Date(Date.now() - 5 * 60000).toISOString() : null, version: null, coverage: 'partial', droppedEvents: 0, droppedEventsExact: true, binding: 'declared' });
      }
      await route.fulfill({ json: { repoId: body.repoId, results: body.items.map(item => ({ provider: item.provider, connectionId: item.connectionId, applied: true, path: reviewItem(item.provider).configPath, nextStep: nextSteps[item.provider] })) } });
      // The real service commits each connection to the store, which the SSE stream pushes.
      snapshot.state.observation = { connections: [...(options.existing ?? []), ...applied.values()] };
      await publish();
      return;
    }
    return route.fulfill({ status: 400, json: { message: 'Unexpected synthetic onboarding operation.' } });
  });
  await page.goto('/');
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  return { snapshot, calls, pageErrors, remote, publish, applied };
}

async function openRepositoryDetails(page: Page) {
  await page.getByRole('button', { name: 'Local project', exact: true }).click();
  await expect(page.getByTestId('room-context')).toHaveAttribute('data-repo-id', 'project');
  await page.getByRole('button', { name: 'Repository details', exact: true }).click();
  const drawer = page.getByTestId('right-drawer');
  await expect(drawer).toBeVisible();
  const panel = drawer.locator('.tracking-panel');
  const row = (label: string) => panel.locator('.tool-row').filter({ has: page.locator('.tool-name', { hasText: label }) });
  return { drawer, panel, row };
}

/** H0-02 (D38): nothing checks this computer on its own. Expand the section if it is collapsed, then press the one button that starts a check. */
async function checkThisComputer(panel: Locator) {
  const show = panel.getByRole('button', { name: 'Show details', exact: true });
  if (await show.isVisible()) await show.click();
  await panel.getByRole('button', { name: 'Check this computer', exact: true }).click();
}

async function seriousViolations(page: Page) {
  const scan = await new AxeBuilder({ page }).include('[data-testid="right-drawer"]').analyze();
  return scan.violations.filter(violation => violation.impact === 'critical' || violation.impact === 'serious').map(violation => ({ id: violation.id, impact: violation.impact, nodes: violation.nodes.map(node => ({ target: node.target.join(' '), summary: node.failureSummary })) }));
}

test('onboarding checks local tools only when asked, reviews the exact hook change unticked and counts only real connections', async ({ page }, testInfo) => {
  const evidence = await onboardingFixture(page);
  const canvas = await page.locator('canvas').elementHandle();
  const { drawer, panel, row } = await openRepositoryDetails(page);
  const heading = panel.locator('.tracking-head h3');
  await expect(heading).toHaveText('Live tracking: 0 of 4 tools connected');
  // The panel leads the drawer, above the roster and the repository facts.
  const panelBox = await panel.boundingBox(), rosterBox = await drawer.getByTestId('repository-agents').boundingBox();
  expect(panelBox!.y).toBeLessThan(rosterBox!.y);

  // D38 (H0-02): opening a fresh project's house checks nothing. The section is collapsed, no tool is listed and no request
  // was sent, not even a health poll (the project has no connection). It used to run detection on its own and expand itself.
  await expect(panel.getByRole('button', { name: 'Show details', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect(panel.locator('.tool-row')).toHaveCount(0);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.waitForTimeout(500);
  expect(evidence.calls).toEqual([]);
  // Expanding only shows the section, with the one button that starts a check.
  await panel.getByRole('button', { name: 'Show details', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Hide details', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.getByRole('button', { name: 'Check this computer', exact: true })).toBeEnabled();
  await expect(panel.locator('.tool-row')).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(evidence.calls).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('onboarding-before-check.png') });
  expect.soft(await seriousViolations(page), 'axe: expanded, before the check').toEqual([]);
  await panel.getByRole('button', { name: 'Check this computer', exact: true }).click();

  // The check lists what it found (these assertions predate H0-02, when the rows appeared on their own).
  await expect(panel.locator('.tool-row')).toHaveCount(4);
  // The one check button keeps keyboard focus through the check (it now reads Recheck tools), so nobody is dropped to the page.
  await expect(panel.getByRole('button', { name: 'Recheck tools', exact: true })).toBeFocused();
  await expect(row('Codex')).toContainText('18 sessions found for this project');
  await expect(row('Claude Code')).toContainText('3 sessions found for this project');
  await expect(row('Cursor')).toContainText('Settings folder found — no activity for this project yet');
  await expect(row('Copilot CLI')).toContainText('Not found on this machine');
  const toggle = panel.getByRole('button', { name: 'Hide details' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const detections = () => evidence.calls.filter(call => call.path === prefix && call.method === 'GET');
  expect(detections().map(call => call.query)).toEqual(['?repoId=project']);
  expect(evidence.calls.filter(call => call.method !== 'GET')).toEqual([]);

  // "Set up anyway" adds a found-but-idle tool (settings folder found, no activity) to the review set, and can be undone.
  await expect(panel.getByRole('button', { name: 'Review & connect 2 tools', exact: true })).toBeEnabled();
  await expect(row('Codex').getByRole('button', { name: /Set up/ })).toHaveCount(0);
  await expect(row('Copilot CLI').getByRole('button', { name: /Set up/ })).toHaveCount(0);
  await row('Cursor').getByRole('button', { name: 'Set up anyway for Cursor', exact: true }).click();
  await expect(row('Cursor')).toContainText('Will be included when you review.');
  await row('Cursor').getByRole('button', { name: 'Undo setting up Cursor', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Review & connect 2 tools', exact: true })).toBeEnabled();
  await row('Cursor').getByRole('button', { name: 'Set up anyway for Cursor', exact: true }).click();
  await panel.getByRole('button', { name: 'Review & connect 3 tools', exact: true }).click();

  // Review: every requested tool shows its full file change before anything is written, and focus moves into it.
  const reviewHeading = panel.getByRole('heading', { name: 'Review before connecting', exact: true });
  await expect(reviewHeading).toBeVisible();
  await expect(reviewHeading).toBeFocused();
  expect(evidence.calls.find(call => call.path === `${prefix}/review`)?.body).toEqual({ repoId: 'project', providers: ['codex', 'claude', 'cursor'] });
  expect(evidence.calls.find(call => call.path === `${prefix}/review`)?.idempotency).toMatch(/^[a-f0-9-]{36}$/);
  const reviews = panel.locator('.tool-review');
  await expect(reviews).toHaveCount(3);
  for (const [index, provider] of (['codex', 'claude', 'cursor'] as const).entries()) {
    await expect(reviews.nth(index)).toContainText(`will add a hook to ${configFile[provider]}`);
    await expect(reviews.nth(index)).toContainText(`After applying: ${nextSteps[provider]}`);
    const diff = reviews.nth(index).locator('pre.setup-code');
    await expect(diff).toBeVisible();
    await expect(diff).toHaveAttribute('tabindex', '0');
    await expect(diff).toContainText('hook-bridge.cjs');
    await expect(diff).toContainText(connectionIds[provider]);
    expect((await diff.innerText()).split('\n').length).toBeGreaterThan(5);
  }
  await expect(panel.locator('.tool-row')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Recheck tools' })).toHaveCount(0);

  // D38, D40 (H0-02): the review opens with nothing ticked and Apply off. Finding a tool is not choosing to connect it.
  // (It used to arrive with every tool found already ticked, "Apply reviewed hooks (3)" on, and the overlap alert showing.)
  for (const provider of ['codex', 'claude', 'cursor'] as const) await expect(panel.getByRole('checkbox', { name: new RegExp(`^${labels[provider]}`) })).not.toBeChecked();
  await expect(panel.getByRole('button', { name: 'Apply reviewed hooks (0)', exact: true })).toBeDisabled();
  await expect(panel.locator('.write-summary')).toHaveText('Nothing selected. Choose at least one tool to connect.');
  await expect(panel.getByRole('alert'), 'no overlap is reported until a conflicting pair is ticked').toHaveCount(0);
  expect(evidence.calls.some(call => call.path === `${prefix}/apply`)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('onboarding-review-unticked.png') });
  expect.soft(await seriousViolations(page), 'axe: review open, nothing ticked').toEqual([]);
  await panel.getByRole('checkbox', { name: /^Codex/ }).check();
  await expect(panel.getByRole('button', { name: 'Apply reviewed hooks (1)', exact: true })).toBeEnabled();
  await panel.getByRole('checkbox', { name: /^Claude Code/ }).check();
  await panel.getByRole('checkbox', { name: /^Cursor/ }).check();

  // Claude Code and Cursor read each other's hook files, so together they would silently reject events.
  await expect(panel.getByRole('alert')).toContainText('Claude Code would not be able to report if Cursor is connected too');
  await expect(panel.getByRole('button', { name: 'Apply reviewed hooks (3)', exact: true })).toBeDisabled();
  await panel.getByRole('checkbox', { name: /^Cursor/ }).uncheck();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Apply reviewed hooks (2)', exact: true })).toBeEnabled();
  await expect(panel.locator('.write-summary')).toHaveText('You are about to write to 2 files: .codex/hooks.json, .claude/settings.local.json');

  // Unchecking updates the count and the write summary; nothing is applied yet.
  await panel.getByRole('checkbox', { name: /^Claude Code/ }).uncheck();
  await expect(panel.getByRole('button', { name: 'Apply reviewed hooks (1)', exact: true })).toBeEnabled();
  await expect(panel.locator('.write-summary')).toHaveText('You are about to write to 1 file: .codex/hooks.json');
  await panel.getByRole('checkbox', { name: /^Codex/ }).uncheck();
  await expect(panel.getByRole('button', { name: 'Apply reviewed hooks (0)', exact: true })).toBeDisabled();
  await expect(panel.locator('.write-summary')).toHaveText('Nothing selected. Choose at least one tool to connect.');
  await panel.getByRole('checkbox', { name: /^Codex/ }).check();
  await panel.getByRole('checkbox', { name: /^Claude Code/ }).check();
  await expect(panel.locator('.write-summary')).toHaveText('You are about to write to 2 files: .codex/hooks.json, .claude/settings.local.json');
  expect(evidence.calls.some(call => call.path === `${prefix}/apply`)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('onboarding-review.png') });
  expect.soft(await seriousViolations(page), 'axe: review open').toEqual([]);

  // Apply sends exactly the reviewed connection ids for the checked tools, then names each tool's next step.
  await panel.getByRole('button', { name: 'Apply reviewed hooks (2)', exact: true }).click();
  const notice = panel.locator('.form-notice');
  await expect(notice).toContainText('Hooks added for 2 tools.');
  await expect(notice).toContainText('Next step in each tool:');
  await expect(notice.locator('li').filter({ hasText: 'Codex' })).toContainText('run /hooks');
  await expect(notice.locator('li').filter({ hasText: 'Claude Code' })).toContainText('reloads this settings file');
  await expect(notice).toBeFocused();
  const apply = evidence.calls.filter(call => call.path === `${prefix}/apply`);
  expect(apply).toHaveLength(1);
  expect(apply[0]!.body).toEqual({ repoId: 'project', items: [{ provider: 'codex', connectionId: connectionIds.codex }, { provider: 'claude', connectionId: connectionIds.claude }] });
  expect(apply[0]!.idempotency).toMatch(/^[a-f0-9-]{36}$/);

  // The header counts saved connections; rows separate receipt from configuration and say what to do next.
  await expect(heading).toHaveText('Live tracking: 2 of 4 tools connected · 1 not receiving yet');
  await expect(panel.locator('.tool-row')).toHaveCount(4);
  await expect(row('Codex')).toContainText(/Receiving activity \(last event \d+m ago\)/);
  await expect(row('Claude Code')).toContainText('Hook applied, waiting for first activity');
  await expect(row('Claude Code')).toContainText(nextSteps.claude);
  await expect(row('Cursor')).toContainText('Settings folder found — no activity for this project yet');
  await expect(row('Cursor').getByRole('button', { name: 'Set up anyway for Cursor', exact: true })).toBeVisible();
  await expect(row('Copilot CLI')).toContainText('Not found on this machine');
  await expect(panel.getByRole('button', { name: /Review & connect/ })).toHaveCount(0);
  // A tool whose settings folder was found is still unconnected, so the panel must not claim everything is done.
  await expect(panel.locator('.tracking-summary')).toHaveCount(0);
  await expect(panel.locator('.tool-review')).toHaveCount(0);
  expect(detections()).toHaveLength(2);
  expect(await page.locator('canvas').evaluate((node, old) => node === old, canvas)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('onboarding-connected.png') });
  expect.soft(await seriousViolations(page), 'axe: resolved rows').toEqual([]);

  // Collapsing and reopening keeps the resolved rows without another detection call.
  await panel.getByRole('button', { name: 'Hide details' }).click();
  await expect(panel.locator('.tool-row')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Show details' })).toHaveAttribute('aria-expanded', 'false');
  await panel.getByRole('button', { name: 'Show details' }).click();
  await expect(row('Claude Code')).toContainText('Hook applied, waiting for first activity');
  expect(detections()).toHaveLength(2);
  expect(evidence.remote).toEqual([]); expect(evidence.pageErrors).toEqual([]);
});

test('a project with a saved connection starts collapsed, updates from live state and only detects on request', async ({ page }) => {
  // (Its behaviour is what D38 asks for and stays; only the entry to the rows changed, see the note at the top of this file.)
  const existing: ObservationConnection = { id: connectionIds.codex, provider: 'codex', repoId: 'project', label: 'Codex (auto-detected)', status: 'unverified', createdAt: '2026-09-15T12:00:00.000Z', lastEventAt: null, version: null, coverage: 'partial', droppedEvents: 0, droppedEventsExact: true };
  const evidence = await onboardingFixture(page, { existing: [existing] });
  evidence.applied.set('codex', existing);
  const { panel, row } = await openRepositoryDetails(page);
  await expect(panel.locator('.tracking-head h3')).toHaveText('Live tracking: 1 of 4 tools connected · 1 not receiving yet');
  await expect(panel.getByRole('button', { name: 'Show details' })).toBeVisible();
  await expect(panel.locator('.tool-row')).toHaveCount(0);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(evidence.calls.filter(call => call.path === prefix)).toEqual([]);

  // H0-02: expanding only shows the section; rows come from a check the person starts. (Before, Show details started it.)
  await panel.getByRole('button', { name: 'Show details' }).click();
  await expect(panel.getByRole('button', { name: 'Check this computer', exact: true })).toBeEnabled();
  await page.waitForTimeout(300);
  expect(evidence.calls.filter(call => call.path === prefix)).toEqual([]);
  await panel.getByRole('button', { name: 'Check this computer', exact: true }).click();
  await expect(row('Codex')).toContainText('Hook applied, waiting for first activity');
  await expect(row('Codex')).toContainText(nextSteps.codex);
  await expect(row('Codex').getByRole('button', { name: /Set up/ })).toHaveCount(0);
  await expect(row('Claude Code')).toContainText('3 sessions found for this project');
  await expect(panel.getByRole('button', { name: 'Review & connect 1 tool', exact: true })).toBeEnabled();
  await expect(panel.getByRole('button', { name: 'Recheck tools' })).toBeEnabled();
  await expect(panel.locator('.tracking-summary')).toHaveCount(0);
  expect(evidence.calls.filter(call => call.path === prefix)).toHaveLength(1);

  // The first event arrives through the live snapshot: the row updates without another detection.
  existing.status = 'receiving'; existing.lastEventAt = new Date().toISOString();
  await evidence.publish();
  await expect(row('Codex')).toContainText(/Receiving activity \(last event/);
  await expect(row('Codex')).not.toContainText(nextSteps.codex);
  await expect(panel.locator('.tracking-head h3')).toHaveText('Live tracking: 1 of 4 tools connected');
  // A connection revoked elsewhere is not shown as live, and the count drops.
  existing.status = 'revoked';
  await evidence.publish();
  await expect(panel.locator('.tracking-head h3')).toHaveText('Live tracking: 0 of 4 tools connected');
  await expect(row('Codex')).toContainText('This connection was revoked.');
  expect(evidence.calls.filter(call => call.path === prefix)).toHaveLength(1);

  evidence.applied.delete('codex');
  await panel.getByRole('button', { name: 'Recheck tools' }).click();
  await expect.poll(() => evidence.calls.filter(call => call.path === prefix).length).toBe(2);
  await expect(row('Codex')).toContainText('18 sessions found for this project');
  await expect(panel.getByRole('button', { name: 'Recheck tools' })).toBeFocused();
  expect(evidence.calls.filter(call => call.method !== 'GET')).toEqual([]);
  expect(evidence.remote).toEqual([]); expect(evidence.pageErrors).toEqual([]);
});

test('a failed detection shows its error without a permanent checking state and can be retried in place', async ({ page }, testInfo) => {
  let attempts = 0;
  const evidence = await onboardingFixture(page, { detection: () => ++attempts === 1 ? { status: 503, body: { message: 'Synthetic profile store is temporarily unavailable.' } } : undefined });
  const { panel, row } = await openRepositoryDetails(page);
  // D38 (H0-02): nothing runs on open, so this failure is reachable only after the person presses the button (it used to fire on mount).
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await checkThisComputer(panel);
  await expect(panel.getByRole('alert')).toHaveText('Synthetic profile store is temporarily unavailable.');
  await page.screenshot({ path: testInfo.outputPath('onboarding-detection-failed.png') });
  // A failure is not a loading state, and retrying is offered in place: the same button, still named for the check that never produced a result.
  await expect(panel.getByText('Checking local files…')).toHaveCount(0);
  await expect(panel.locator('.spin')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: /Review & connect/ })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Check this computer', exact: true })).toBeEnabled();
  expect(evidence.calls.filter(call => call.method !== 'GET')).toEqual([]);

  await panel.getByRole('button', { name: 'Check this computer', exact: true }).click();
  await expect(row('Codex')).toContainText('18 sessions found for this project');
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Review & connect 2 tools', exact: true })).toBeEnabled();
  expect(attempts).toBe(2);
  expect(evidence.remote).toEqual([]); expect(evidence.pageErrors).toEqual([]);
});

test('Claude Code already connected blocks adding Cursor, and Escape cancels only the review', async ({ page }) => {
  const claude: ObservationConnection = { id: connectionIds.claude, provider: 'claude', repoId: 'project', label: 'Claude Code (auto-detected)', status: 'receiving', createdAt: '2026-09-15T12:00:00.000Z', lastEventAt: new Date().toISOString(), version: null, coverage: 'partial', droppedEvents: 0, droppedEventsExact: true };
  const evidence = await onboardingFixture(page, { existing: [claude] });
  evidence.applied.set('claude', claude);
  const { drawer, panel, row } = await openRepositoryDetails(page);
  await checkThisComputer(panel);
  await expect(row('Claude Code')).toContainText(/Receiving activity \(last event/);
  await row('Cursor').getByRole('button', { name: 'Set up anyway for Cursor', exact: true }).click();
  await panel.getByRole('button', { name: /^Review & connect/ }).first().click();
  await expect(panel.getByRole('heading', { name: 'Review before connecting' })).toBeFocused();
  // D38 (H0-02): the review opens with nothing ticked, so the overlap warning appears only once Cursor is ticked (it used to be there on arrival).
  await expect(panel.getByRole('checkbox', { name: /^Cursor/ })).not.toBeChecked();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: /^Apply reviewed hooks/ })).toBeDisabled();
  await panel.getByRole('checkbox', { name: /^Cursor/ }).check();
  await expect(panel.getByRole('alert')).toContainText('Claude Code would not be able to report if Cursor is connected too');
  await expect(panel.getByRole('button', { name: /^Apply reviewed hooks/ })).toBeDisabled();

  // Escape closes the review step, not the whole drawer, and focus goes back to the action that opened it.
  await page.keyboard.press('Escape');
  await expect(panel.locator('.tool-review-list')).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect(panel.getByRole('button', { name: /^Review & connect/ }).first()).toBeFocused();
  expect(evidence.calls.some(call => call.path === `${prefix}/apply`)).toBe(false);
  expect(evidence.pageErrors).toEqual([]);
});

test('a refused apply shows its reason, leaves nothing half-connected and moves focus to the message', async ({ page }) => {
  const evidence = await onboardingFixture(page, { apply: () => ({ status: 409, body: { code: 'PROJECT_FOLDER_UNAVAILABLE', message: 'This project folder could not be read. Check that it still exists inside an allowed folder, then try again.' } }) });
  const { panel, row } = await openRepositoryDetails(page);
  await checkThisComputer(panel);
  await expect(row('Codex')).toContainText('18 sessions found for this project');
  await panel.getByRole('button', { name: 'Review & connect 2 tools', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Review before connecting' })).toBeFocused();
  // D38 (H0-02): nothing is ticked on arrival, so the person ticks the two tools they want before Apply turns on.
  await expect(panel.getByRole('button', { name: 'Apply reviewed hooks (0)', exact: true })).toBeDisabled();
  await panel.getByRole('checkbox', { name: /^Codex/ }).check();
  await panel.getByRole('checkbox', { name: /^Claude Code/ }).check();
  await panel.getByRole('button', { name: 'Apply reviewed hooks (2)', exact: true }).click();
  const alert = panel.getByRole('alert');
  await expect(alert).toHaveText('This project folder could not be read. Check that it still exists inside an allowed folder, then try again.');
  await expect(alert).toBeFocused();
  await expect(panel.locator('.tool-review-list')).toHaveCount(0);
  await expect(panel.locator('.tracking-head h3')).toHaveText('Live tracking: 0 of 4 tools connected');
  expect(evidence.applied.size).toBe(0);
  // A fresh review is one click away; nothing stale is left to resubmit.
  await expect(panel.getByRole('button', { name: 'Review & connect 2 tools', exact: true })).toBeEnabled();
  expect(evidence.remote).toEqual([]); expect(evidence.pageErrors).toEqual([]);
});

test('some tools connecting and one failing shows both outcomes, and the failure is announced as an error', async ({ page }) => {
  const evidence = await onboardingFixture(page, { apply: () => ({ status: 200, body: { repoId: 'project', results: [
    { provider: 'codex', connectionId: connectionIds.codex, applied: true, path: reviewItem('codex').configPath, nextStep: nextSteps.codex },
    { provider: 'claude', connectionId: connectionIds.claude, applied: false, error: 'The existing hook JSON is invalid. Fix it before applying this connection.' },
  ] } }) });
  const { panel } = await openRepositoryDetails(page);
  await checkThisComputer(panel);
  await panel.getByRole('button', { name: 'Review & connect 2 tools', exact: true }).click();
  // D38 (H0-02): nothing is ticked on arrival; tick the two tools, then apply.
  await panel.getByRole('checkbox', { name: /^Codex/ }).check();
  await panel.getByRole('checkbox', { name: /^Claude Code/ }).check();
  await panel.getByRole('button', { name: 'Apply reviewed hooks (2)', exact: true }).click();
  // The success is a notice with the tool's next step; the failure is a separate alert, never inside the green message.
  const notice = panel.locator('.form-notice');
  await expect(notice).toContainText('Hooks added for 1 tool.');
  await expect(notice).toContainText(nextSteps.codex);
  await expect(notice).not.toContainText('Claude Code');
  const alert = panel.getByRole('alert');
  await expect(alert).toContainText('This tool could not be connected:');
  await expect(alert).toContainText('Claude Code: The existing hook JSON is invalid. Fix it before applying this connection.');
  await expect(notice).toBeFocused();
  expect(evidence.remote).toEqual([]); expect(evidence.pageErrors).toEqual([]);
});

test('a connection whose events are being rejected is flagged, but only while the rejection is newer than its last event', async ({ page }) => {
  const now = Date.now();
  const rejected: ObservationConnection = { id: connectionIds.claude, provider: 'claude', repoId: 'project', label: 'Claude Code (auto-detected)', status: 'receiving', createdAt: '2026-09-15T12:00:00.000Z', lastEventAt: new Date(now - 3600000).toISOString(), version: null, coverage: 'partial', droppedEvents: 0, droppedEventsExact: true, diagnostics: [{ code: 'hook-overlap', message: 'Other Agent Town callbacks are installed in this project, so its events are being rejected.', lastSeenAt: new Date(now - 60000).toISOString() }] };
  const evidence = await onboardingFixture(page, { existing: [rejected] });
  evidence.applied.set('claude', rejected);
  const { panel, row } = await openRepositoryDetails(page);
  // Visible without opening the details, because a collapsed panel must not read as healthy.
  await expect(panel.locator('.tracking-head h3')).toHaveText('Live tracking: 1 of 4 tools connected · 1 needs attention');
  // H0-02: the per-tool rows come from a check the person starts (the headline above needs none: it is the saved state).
  await checkThisComputer(panel);
  await expect(row('Claude Code')).toContainText('Needs attention: Other Agent Town callbacks are installed in this project, so its events are being rejected.');
  await expect(row('Claude Code')).not.toContainText('Receiving activity');
  await expect(row('Claude Code')).not.toContainText(nextSteps.claude);

  // The button opens the manual flow already set to that tool.
  await row('Claude Code').getByRole('button', { name: 'Review Claude Code tracking' }).click();
  await expect(page.getByRole('heading', { name: 'Set up local agent tracking', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Agent tool', exact: true })).toHaveValue('claude');

  expect(evidence.pageErrors).toEqual([]);
});

test('a rejection older than the last accepted event has cleared itself and is not flagged', async ({ page }) => {
  const now = Date.now();
  const healed: ObservationConnection = { id: connectionIds.claude, provider: 'claude', repoId: 'project', label: 'Claude Code (auto-detected)', status: 'receiving', createdAt: '2026-09-15T12:00:00.000Z', lastEventAt: new Date(now - 120000).toISOString(), version: null, coverage: 'partial', droppedEvents: 0, droppedEventsExact: true, diagnostics: [{ code: 'hook-overlap', message: 'Other Agent Town callbacks are installed in this project, so its events are being rejected.', lastSeenAt: new Date(now - 3600000).toISOString() }] };
  const evidence = await onboardingFixture(page, { existing: [healed] });
  evidence.applied.set('claude', healed);
  const { panel, row } = await openRepositoryDetails(page);
  await expect(panel.locator('.tracking-head h3')).toHaveText('Live tracking: 1 of 4 tools connected');
  await checkThisComputer(panel);
  await expect(row('Claude Code')).toContainText(/Receiving activity \(last event/);
  await expect(row('Claude Code')).not.toContainText('Needs attention');
  expect(evidence.pageErrors).toEqual([]);
});
