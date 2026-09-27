import { expect, test, type Page } from '@playwright/test';
import type { BrowserSession, CoordinationPlan, CreateRunDraft, ManagerConfig, ObservationSetup, Repository, RunnerTask, ServiceTraffic, Snapshot, TelemetrySource, WorkflowState } from '@agent-town/contracts';

// These browser contract fixtures test the UI without a GitHub account or private files.
// Real GitHub authorization and repository scanning have separate service smoke gates.
async function installEventFixture(page: Page) {
  await page.addInitScript(() => {
    class FixtureEventSource extends EventTarget {
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      closed = false;
      private readonly listener: EventListener;
      constructor(readonly url: string) {
        super();
        this.listener = (event: Event) => {
          const snapshot = (event as CustomEvent).detail;
          if (!this.closed && url.includes(`/workspaces/${snapshot.state.workspace.id}/`)) this.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(snapshot) }));
        };
        window.addEventListener('fixture-workspace-state', this.listener);
        setTimeout(() => { if (!this.closed) this.onopen?.(new Event('open')); }, 0);
      }
      close() { this.closed = true; window.removeEventListener('fixture-workspace-state', this.listener); }
    }
    window.EventSource = FixtureEventSource as unknown as typeof EventSource;
  });
}

function emptySnapshot(id: string, name: string): Snapshot {
  return { cursor: 1, state: { schemaVersion: 1, workspace: { id, name, mode: 'private' }, runner: { schemaVersion: 1, tasks: [], runs: [], subscriptions: [], subscriptionDefault: null }, simulation: { running: false, step: 0 }, agents: [], repositories: [], handoffs: [], activity: [], manager: { version: 0, brief: 'Manager disabled. No reports received.', updatedAt: null }, discovery: { roots: [], candidates: [], operation: null } } };
}

function emptyCoordination(snapshot: Snapshot): CoordinationPlan {
  const limit = snapshot.state.workflow?.policy.workerConcurrency ?? 1;
  return { schemaVersion: 1, advisoryOnly: true, inferenceCalls: 0, contextVersion: snapshot.state.manager.version, capacity: { limit, active: 0, available: limit }, tasks: [], suggestedTaskIds: [] };
}

test('pending subscription instructions resume after closing the panel without starting another login', async ({ page }, testInfo) => {
  await installEventFixture(page);
  const snapshot = emptySnapshot('resume-workspace', 'Sign-in recovery');
  snapshot.state.workflow = { schemaVersion: 1, connections: [], defaults: {}, policy: { paidEnabled: false, dailyBudgetMicroUsd: 0, managerDailyBudgetMicroUsd: 0, maxRunBudgetMicroUsd: 0, workerConcurrency: 1, timeZone: 'UTC' }, reservations: [], manager: { config: { enabled: false, connectionId: null, model: null, maxInputTokens: 4096, maxOutputTokens: 800, requestBudgetMicroUsd: 0 }, queueReportIds: [], jobs: [], versions: [], proposals: [], automaticStarts: [] } };
  snapshot.state.runner!.subscriptions = [{ id: 'pending-native', label: 'Pending personal account', status: 'pending', createdAt: new Date().toISOString(), accountLabel: null, accountFingerprint: null, models: [] }];
  let reads = 0;
  const mutations: string[] = [];
  await page.route('**/api/v1/session', async route => {
    const upstream = await route.fetch(); const body = await upstream.json();
    await route.fulfill({ response: upstream, json: { ...body, mode: 'private', user: { id: 'resume-owner', login: 'fixture-owner', displayName: null, avatarUrl: null }, workspaces: [{ id: 'resume-workspace', name: 'Sign-in recovery', kind: 'personal' }] } });
  });
  await page.route('**/api/v1/workspaces/resume-workspace/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') mutations.push(path);
    if (path.endsWith('/snapshot')) { await route.fulfill({ json: snapshot }); return; }
    if (path.endsWith('/subscriptions/pending-native')) {
      reads++;
      await route.fulfill({ json: { status: 'pending', message: 'Complete the pending native sign-in.', prompt: { connectionId: 'pending-native', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'FIXTURE-ONLY-CODE', expiresAt: new Date(Date.now() + 60000).toISOString() } } }); return;
    }
    await route.fulfill({ status: 404, json: { message: 'Unexpected fixture action' } });
  });
  await page.goto('/');
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open connections', exact: true }).click();
  await page.getByRole('button', { name: 'Resume sign-in', exact: true }).click();
  await expect(page.getByText('FIXTURE-ONLY-CODE', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close navigation', exact: true }).click();
  await page.getByRole('button', { name: 'Open connections', exact: true }).click();
  await page.getByRole('button', { name: 'Resume sign-in', exact: true }).click();
  await expect(page.getByText('FIXTURE-ONLY-CODE', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open OpenAI sign-in', exact: true })).toHaveAttribute('href', 'https://auth.openai.com/codex/device');
  // UX-33: the frozen Codex subscription sign-in screen shows the same sign-in code warning while it exists.
  const codexWarning = page.getByText('Only enter this code if you started sign-in here just now.', { exact: false });
  await expect(codexWarning).toBeVisible();
  await codexWarning.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `docs/assets/previews/codex-sign-in-code-warning-${testInfo.project.name}.png`, animations: 'disabled' });
  expect(reads).toBeGreaterThanOrEqual(2); expect(mutations).toEqual([]);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))).not.toContain('FIXTURE-ONLY-CODE');
});

test('private repository selection shows real metadata and clears it on workspace change and sign-out', async ({ page }) => {
  await installEventFixture(page);
  const first = emptySnapshot('private-one', 'Owner workspace');
  const second = emptySnapshot('private-two', 'Second workspace');
  const session: BrowserSession = { csrf: 'fixture-private-csrf', mode: 'private', user: { id: 'fixture-owner', login: 'fixture-owner', displayName: 'Fixture Owner', avatarUrl: null }, workspaces: [{ id: 'private-one', name: 'Owner workspace', kind: 'personal' }, { id: 'private-two', name: 'Second workspace', kind: 'company' }], identity: { configured: true } };
  const repository: Repository = { id: 'fixture-repo', name: 'Private project', description: 'Selected local repository', language: 'TypeScript', branch: 'feature/private', color: '#6c8c91', position: [-6, -4], source: 'local', localPath: String.raw`C:\fixture-projects\private-project`, scan: { at: '2026-09-14T12:00:00Z', coverage: 'complete', reasons: [] }, git: { availability: 'available', head: 'a'.repeat(40), changedFiles: 2, untrackedFiles: 1 }, instructions: [{ path: '.claude/CLAUDE.md', tool: 'Claude', scope: 'repository', size: 120, modifiedAt: '2026-09-14T11:00:00Z', hash: 'b'.repeat(64), appliedToRun: false }] };
  const mutations: { path: string; body: unknown }[] = [];
  let loggedOut = false;
  let releaseSecond: (() => void) | undefined;
  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const reply = (body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/v1/session') {
      const upstream = await route.fetch();
      const demo = await upstream.json();
      session.csrf = demo.csrf;
      await route.fulfill({ response: upstream, json: loggedOut ? demo : session }); return;
    }
    if (path === '/api/v1/auth/logout') {
      loggedOut = true;
      const upstream = await route.fetch();
      await route.fulfill({ response: upstream }); return;
    }
    if (path === '/api/v1/workspaces/private-one/snapshot') { await reply(first); return; }
    if (path === '/api/v1/workspaces/private-two/snapshot') { await secondGate; await reply(second); return; }
    if (path.startsWith('/api/v1/workspaces/private-one/') && method === 'POST') {
      mutations.push({ path, body: route.request().postDataJSON() });
      await reply({ ok: true, operationId: 'fixture-scan' }); return;
    }
    await route.continue();
  });
  const publish = async () => { first.cursor++; await page.evaluate(snapshot => window.dispatchEvent(new CustomEvent('fixture-workspace-state', { detail: snapshot })), first); };

  await page.goto('/');
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run demo', exact: true })).toHaveCount(0);
  await expect(page.getByText('Milo', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Connect a project', exact: true }).click();
  await page.getByLabel('Project folder', { exact: true }).fill(String.raw`C:\fixture-projects`);
  await page.getByRole('button', { name: 'Add this project', exact: true }).click();
  await expect.poll(() => mutations.length).toBe(1);
  expect(mutations[0]?.body).toEqual({ path: String.raw`C:\fixture-projects` });
  first.state.discovery!.roots = [String.raw`C:\fixture-projects`];
  await publish();
  await page.getByRole('button', { name: 'Scan selected folders', exact: true }).click();
  await expect.poll(() => mutations.length).toBe(2);
  first.state.discovery!.candidates = [repository];
  first.state.discovery!.operation = { id: 'fixture-scan', status: 'complete', startedAt: '2026-09-14T12:00:00Z', finishedAt: '2026-09-14T12:00:01Z', message: 'Found 1 repository. Review your selection.', coverage: 'complete' };
  await publish();
  await page.getByRole('checkbox', { name: /Private project/ }).check();
  await page.getByRole('button', { name: 'Save repository selection', exact: true }).click();
  await expect.poll(() => mutations.length).toBe(3);
  expect(mutations[2]?.body).toEqual({ ids: ['fixture-repo'] });
  first.state.repositories = [repository];
  await publish();
  await page.getByRole('button', { name: 'Close navigation', exact: true }).click();
  await page.getByRole('button', { name: 'Private project', exact: true }).click();
  await expect(page.getByTestId('room-context')).toHaveAttribute('data-repo-id', 'fixture-repo');
  await page.getByRole('button', { name: 'Repository details', exact: true }).click();
  await expect(page.getByTestId('right-drawer')).toContainText('.claude/CLAUDE.md');
  await expect(page.getByTestId('right-drawer')).toContainText('feature/private');
  await expect(page.getByTestId('right-drawer')).toContainText('Changed files2');
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await page.getByRole('button', { name: 'Open connections', exact: true }).click();
  await page.getByRole('button', { name: /Second workspace.*Company/ }).click();
  await expect(page.getByTestId('left-drawer')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Private project', exact: true })).toHaveCount(0);
  await expect(page.getByText('feature/private', { exact: true })).toHaveCount(0);
  releaseSecond!();
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  await publish(); // A late event from the previous scope must not restore private-one data.
  await expect(page.getByRole('button', { name: 'Private project', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open connections', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out of GitHub', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open connections', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run demo', exact: true })).toHaveCount(0);
  await expect(page.locator('.agent-label')).toHaveCount(0);
  await expect(page.getByText('Fixture Owner', { exact: true })).toHaveCount(0);
  await expect(page.getByText('feature/private', { exact: true })).toHaveCount(0);
});

// UX-05 (Gap 8): "Show welcome tips" only ever reopened the sample town's own dismissible intro card
// (App.tsx's `demo && ... !hintDismissed` world-intro), which a private workspace never renders — pressing
// it here silently did nothing. It must not be offered where it has no real tip to reopen.
test('Show welcome tips is not offered in a private workspace, where it has no real tip to reopen', async ({ page }) => {
  await installEventFixture(page);
  const snapshot = emptySnapshot('tips-workspace', 'Tips workspace');
  const session: BrowserSession = { csrf: 'fixture-tips-csrf', mode: 'private', user: { id: 'fixture-tips-owner', login: 'fixture-tips-owner', displayName: null, avatarUrl: null }, workspaces: [{ id: 'tips-workspace', name: 'Tips workspace', kind: 'personal' }], identity: { configured: true } };
  await page.route('**/api/v1/session', route => route.fulfill({ json: session }));
  await page.route('**/api/v1/workspaces/tips-workspace/snapshot', route => route.fulfill({ json: snapshot }));
  await page.goto('/');
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Show welcome tips', exact: true })).toHaveCount(0);
});

// UX-02: the same qualified privacy sentences (PRIVACY_COPY) must still appear once signed in, since the
// heading that carries them renders regardless of sign-in state. The old unqualified "sends no project
// files or agent activity to GitHub or any AI provider" (removed: false once the manager or a managed
// task runs, SP-3/SH-1) must not be present either way.
test('the Connections drawer states exactly when data leaves this computer once signed in', async ({ page }) => {
  await installEventFixture(page);
  const snapshot = emptySnapshot('privacy-workspace', 'Privacy workshop');
  await routeTasksWorkspace(page, snapshot, []);
  await page.goto('/');
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open connections', exact: true }).click();
  const setup = page.getByRole('region', { name: 'Private workspace setup', exact: true });
  await expect(setup.getByText('Signed in as', { exact: false })).toBeVisible();
  await expect(setup).toContainText('Report text reaches an AI provider only when you press Process, or automatically every 30 seconds if you turn that on.');
  await expect(setup).toContainText('A managed task sends its files and output to an AI provider only once you approve that task.');
  await expect(setup).toContainText('AI credits are used only if you turn on the manager and allow paid work, then either press Process or turn on automatic processing.');
  await expect(setup).not.toContainText('sends no project files or agent activity');
});

test('GitHub device sign-in shows the verified destination and supports cancellation', async ({ page }) => {
  await installEventFixture(page);
  let cancelled = false;
  await page.route('**/api/v1/session', async route => {
    const upstream = await route.fetch();
    const body = await upstream.json();
    await route.fulfill({ response: upstream, json: { ...body, identity: { configured: true } } });
  });
  await page.route('**/api/v1/auth/github/device/start', route => route.fulfill({ json: { flowId: 'fixture-flow', userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device', expiresAt: new Date(Date.now() + 600000).toISOString(), intervalSeconds: 5 } }));
  await page.route('**/api/v1/auth/github/device/cancel', async route => { expect(route.request().postDataJSON()).toEqual({ flowId: 'fixture-flow' }); cancelled = true; await route.fulfill({ json: { ok: true } }); });
  await page.goto('/');
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open connections', exact: true }).click();
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click();
  await expect(page.getByText('ABCD-EFGH', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open GitHub', exact: true })).toHaveAttribute('href', 'https://github.com/login/device?user_code=ABCD-EFGH');
  await expect(page.getByRole('button', { name: 'Copy code', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
  await expect(page.getByText('Sign-in cancelled.', { exact: true })).toBeVisible();
  expect(cancelled).toBe(true);
  await expect(page.getByText('ABCD-EFGH', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in with GitHub', exact: true })).toBeEnabled();
});

test('a completed authorization is reconciled when it wins a cancellation race', async ({ page }) => {
  await installEventFixture(page);
  let authorized = false;
  await page.route('**/api/v1/session', async route => {
    const upstream = await route.fetch(); const body = await upstream.json();
    await route.fulfill({ response: upstream, json: { ...body, identity: { configured: true }, ...(authorized ? { mode: 'private', csrf: 'fixture-rotated-csrf', user: { id: 'race-owner', login: 'race-owner', displayName: 'Race owner', avatarUrl: null }, workspaces: [] } : {}) } });
  });
  await page.route('**/api/v1/auth/github/device/start', route => route.fulfill({ json: { flowId: 'race-flow', userCode: 'RACE-CODE', verificationUri: 'https://github.com/login/device', expiresAt: new Date(Date.now() + 600000).toISOString(), intervalSeconds: 5 } }));
  await page.route('**/api/v1/auth/github/device/cancel', async route => { authorized = true; await route.fulfill({ status: 403, json: { message: 'The previous CSRF value expired.' } }); });
  await page.goto('/?preview=1');
  await expect(page.getByText('Sample town · local service connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open connections', exact: true }).click();
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click();
  await expect(page.getByText('RACE-CODE', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
  // The reconciliation notice is set inside cancelSignIn() itself, the moment the cancel call
  // resolves and refreshSession() sees a user — it does not depend on any further click. WS1-02
  // collapsed the old two-step "outer CTA opens the form" flow into landing on the create-workspace
  // form directly, so its submit button (real, name-gated, and no longer a same-named no-op reveal
  // action) must stay unclicked here — this test is about the notice/session surviving the race, not
  // about actually creating a workspace.
  await expect(page.getByText('GitHub authorization completed before cancellation. Use Sign out to close that session.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create workspace', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.has('preview')).toBe(false);
  await expect(page.getByRole('button', { name: 'Run demo', exact: true })).toHaveCount(0);
  await expect(page.getByText('Race owner', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out of GitHub', exact: true })).toBeEnabled();
});

test('observation setup distinguishes event receipt from verification and task acceptance', async ({ page }) => {
  await installEventFixture(page);
  const snapshot = emptySnapshot('observed-workspace', 'Observation workshop');
  snapshot.state.repositories = [{ id: 'observed-repo', name: 'Observed project', description: 'Local checkout', language: 'TypeScript', branch: 'main', position: [-6, -4], color: '#6c8c91', source: 'local', localPath: String.raw`C:\fixture\observed-project` }];
  snapshot.state.observation = { connections: [] };
  const setup: ObservationSetup = { connection: { id: 'fixture-connection', provider: 'codex', repoId: 'observed-repo', label: 'My observed Codex', status: 'unverified', createdAt: '2026-09-14T12:00:00Z', lastEventAt: null, version: null, coverage: 'partial', droppedEvents: 0 }, configPath: String.raw`C:\fixture\observed-project\.codex\hooks.json`, config: '{ "hooks": {} }', bridgeCommand: 'node fixture-bridge.mjs', instructions: ['Review this fixture configuration. Native compatibility remains unverified.'] };
  let registered = false;
  const hookActions: string[] = [];
  await page.route('**/api/v1/session', async route => {
    const upstream = await route.fetch(); const body = await upstream.json();
    await route.fulfill({ response: upstream, json: { ...body, mode: 'private', user: { id: 'observed-owner', login: 'fixture-owner', displayName: null, avatarUrl: null }, workspaces: [{ id: 'observed-workspace', name: 'Observation workshop', kind: 'personal' }] } });
  });
  await page.route('**/api/v1/workspaces/observed-workspace/snapshot', route => route.fulfill({ json: snapshot }));
  await page.route(/\/api\/v1\/workspaces\/observed-workspace\/agents\/[^/]+\/reports/, route => route.fulfill({ json: { reports: [], reportCount: 0, reportsNextOffset: null } }));
  await page.route('**/api/v1/workspaces/observed-workspace/observation/native-setup?**', async route => { expect(route.request().method()).toBe('GET'); await route.fulfill({ json: { sources: [], tools: [] } }); });
  await page.route('**/api/v1/workspaces/observed-workspace/observation/connections', async route => {
    expect(route.request().postDataJSON()).toEqual({ provider: 'codex', repoId: 'observed-repo', label: 'My observed Codex' });
    registered = true; await route.fulfill({ json: setup });
  });
  await page.route('**/api/v1/workspaces/observed-workspace/observation/connections/fixture-connection/*', async route => {
    if (new URL(route.request().url()).pathname.endsWith('/setup')) { expect(route.request().method()).toBe('GET'); await route.fulfill({ json: setup }); return; }
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['idempotency-key']).toMatch(/^[a-f0-9-]{36}$/);
    hookActions.push(new URL(route.request().url()).pathname.split('/').at(-1)!);
    await route.fulfill({ json: { ok: true } });
  });
  const publish = async () => { snapshot.cursor++; await page.evaluate(value => window.dispatchEvent(new CustomEvent('fixture-workspace-state', { detail: value })), snapshot); };
  await page.goto('/');
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open connections', exact: true }).click();
  // H0-09: the manual form no longer mounts (and reads no native-setup) just from opening Connections; it opens on request.
  await page.getByRole('button', { name: 'Set up tracking', exact: true }).click();
  await page.getByRole('combobox', { name: 'Agent tool', exact: true }).selectOption('codex');
  await page.getByRole('combobox', { name: 'Repository for observation', exact: true }).selectOption('observed-repo');
  await page.getByLabel('Connection label', { exact: true }).fill('My observed Codex');
  await page.getByRole('button', { name: 'Prepare observation setup', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Proposed hook configuration', exact: true })).toHaveValue('{ "hooks": {} }');
  expect(registered).toBe(true);
  await page.getByRole('button', { name: 'Apply reviewed Agent Town hook', exact: true }).click();
  await expect.poll(() => hookActions).toEqual(['apply']);
  snapshot.state.observation!.connections = [setup.connection];
  await publish();
  await expect(page.getByText('Waiting for first event', { exact: true })).toBeVisible();
  await expect(page.getByText('Partial · native verification required', { exact: true })).toBeVisible();
  setup.connection.status = 'receiving'; setup.connection.lastEventAt = '2026-09-14T12:01:00Z';
  snapshot.state.agents = [{ id: 'observed-agent', name: 'Codex session', provider: 'Codex', role: 'Observed session', repoId: 'observed-repo', task: 'Task not linked', activity: 'working', color: '#6c8c91', home: [-5.4, -0.5], updatedAt: '2026-09-14T12:01:00Z', files: [], evidence: 'Observed tool event', contextVersion: null, observation: { connectionId: setup.connection.id, sessionId: 'fixture-session', parentSessionId: null, lastSequence: 1, sourceTime: '2026-09-14T12:01:00Z', freshness: 'current', billing: 'unavailable' } }];
  await publish();
  await expect(page.getByText('Receiving events', { exact: true })).toBeVisible();
  await expect(page.getByText('Partial · native verification required', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close navigation', exact: true }).click();
  await page.getByRole('button', { name: 'Open agents', exact: true }).click();
  await page.getByRole('button', { name: /Codex session.*Codex.*Observed session/ }).click();
  await expect(page.getByTestId('right-drawer')).toContainText('External · unavailable');
  await expect(page.getByRole('button', { name: 'Send sample report', exact: true })).toHaveCount(0);
  snapshot.state.agents[0]!.activity = 'idle'; snapshot.state.agents[0]!.observation!.freshness = 'stale';
  await publish();
  await expect(page.getByTestId('right-drawer')).toContainText('Response finished');
  await expect(page.getByTestId('right-drawer')).toContainText('Last reported · stale');
  await expect(page.getByTestId('right-drawer').getByRole('button', { name: 'Review activity tracking', exact: true })).toBeVisible();
  await expect(page.getByTestId('right-drawer')).toContainText('does not accept a task');
  await expect(page.getByTestId('right-drawer').getByText('Awaiting review', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  if (await page.getByRole('button', { name: 'Connections', exact: true }).count()) await page.getByRole('button', { name: 'Connections', exact: true }).click();
  else await page.getByRole('button', { name: 'Open connections', exact: true }).click();
  await page.getByRole('button', { name: 'Revoke observation', exact: true }).click();
  await expect.poll(() => hookActions).toEqual(['apply', 'revoke']);
  setup.connection.status = 'revoked'; await publish();
  await expect(page.getByText('Revoked', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove Agent Town hook', exact: true }).click();
  await expect.poll(() => hookActions).toEqual(['apply', 'revoke', 'remove-hooks']);
  await expect(page.getByText('Revoked Agent Town hook removed. Unrelated hooks are preserved.', { exact: true })).toBeVisible();
});

test('API credentials clear after verification and paid manager controls require reviewed limits', async ({ page }, testInfo) => {
  await installEventFixture(page);
  const snapshot = emptySnapshot('budget-workspace', 'Budget workshop');
  const workflow: WorkflowState = { schemaVersion: 1, connections: [], defaults: {}, policy: { paidEnabled: false, dailyBudgetMicroUsd: 0, managerDailyBudgetMicroUsd: 0, maxRunBudgetMicroUsd: 0, workerConcurrency: 1, timeZone: 'UTC' }, reservations: [], manager: { config: { enabled: false, connectionId: null, model: null, maxInputTokens: 4096, maxOutputTokens: 800, requestBudgetMicroUsd: 0 }, queueReportIds: ['fixture-report'], jobs: [], versions: [], proposals: [], automaticStarts: [] } };
  snapshot.state.workflow = workflow;
  snapshot.state.handoffs = [{ id: 'fixture-report', agentId: 'fixture-agent', repoId: 'fixture-repo', summary: 'A fixture report awaits processing.', createdAt: '2026-09-14T12:00:00Z', status: 'saved', contextVersion: null, delivery: 'unsupported' }];
  let finishManagerProcess: (() => void) | undefined;
  const requests: { path: string; method: string; body: unknown }[] = [];
  await page.route('**/api/v1/session', async route => {
    const upstream = await route.fetch(); const body = await upstream.json();
    await route.fulfill({ response: upstream, json: { ...body, mode: 'private', user: { id: 'budget-owner', login: 'fixture-owner', displayName: null, avatarUrl: null }, workspaces: [{ id: 'budget-workspace', name: 'Budget workshop', kind: 'company' }] } });
  });
  await page.route('**/api/v1/workspaces/budget-workspace/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/coordination')) { expect(route.request().method()).toBe('GET'); await route.fulfill({ json: emptyCoordination(snapshot) }); return; }
    if (route.request().method() === 'GET') { await route.fulfill({ json: snapshot }); return; }
    expect(route.request().headers()['idempotency-key']).toMatch(/^[a-f0-9-]{36}$/);
    requests.push({ path, method: route.request().method(), body: route.request().postDataJSON() });
    if (path.endsWith('/manager/process')) await new Promise<void>(resolve => { finishManagerProcess = resolve; });
    await route.fulfill({ json: { snapshot } });
  });
  const publish = async () => { snapshot.cursor++; await page.evaluate(value => window.dispatchEvent(new CustomEvent('fixture-workspace-state', { detail: value })), snapshot); };
  await page.goto('/');
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open manager', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Process saved reports · paid', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await page.getByRole('button', { name: 'Open connections', exact: true }).click();
  const claudeSetup = page.getByRole('region', { name: 'Claude subscription setup', exact: true });
  await expect(claudeSetup).toContainText('Agent Town does not offer Claude sign-in: sign in inside Claude Code.');
  await expect(claudeSetup).not.toContainText('Scroll down in Connections');
  await claudeSetup.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `docs/assets/previews/account-subscriptions-${testInfo.project.name}.png`, animations: 'disabled' });
  await page.getByRole('button', { name: 'API credits', exact: true }).click();
  await page.getByLabel('Billing connection label', { exact: true }).fill('Company fixture');
  const key = page.getByLabel('API key', { exact: true });
  await expect(key).toHaveAttribute('type', 'password');
  await key.fill('sk-fixture-credential-no-real-access');
  await page.getByRole('button', { name: 'Verify and save API connection', exact: true }).click();
  await expect(key).toHaveValue('');
  expect(requests).toHaveLength(1);
  expect(requests[0]?.body).toMatchObject({ provider: 'openai', label: 'Company fixture', apiKey: 'sk-fixture-credential-no-real-access' });
  expect(await page.evaluate(() => Object.values(localStorage).join('\n'))).not.toContain('sk-fixture-credential-no-real-access');
  workflow.connections = [{ id: 'fixture-api', provider: 'openai', mode: 'api', label: 'Company fixture', status: 'verified', verifiedAt: '2026-09-14T12:00:00Z', createdAt: '2026-09-14T12:00:00Z', accountIdentity: 'unavailable', models: ['fixture-economy-model'], capabilities: { manager: true, managedExecution: false } }];
  workflow.defaults = { 'openai:api': 'fixture-api' };
  await publish();
  await page.getByRole('button', { name: 'Usage', exact: true }).click();
  await page.getByLabel('Workspace daily limit (USD)', { exact: true }).fill('-1');
  await page.getByRole('button', { name: 'Save Economy limits', exact: true }).click();
  await expect(page.getByText('Use a dollar amount with up to six decimal places.', { exact: true })).toBeVisible();
  expect(requests).toHaveLength(1);
  await page.getByLabel('Workspace daily limit (USD)', { exact: true }).fill('0.50');
  await page.getByLabel('Manager daily allowance (USD)', { exact: true }).fill('0.25');
  await page.getByLabel('Maximum per-run limit (USD)', { exact: true }).fill('0.10');
  await page.getByRole('checkbox', { name: 'Permit paid work within these saved limits', exact: true }).check();
  await page.getByRole('button', { name: 'Save Economy limits', exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toMatchObject({ method: 'PATCH', body: { paidEnabled: true, dailyBudgetMicroUsd: 500000, managerDailyBudgetMicroUsd: 250000, maxRunBudgetMicroUsd: 100000 } });
  workflow.policy = requests[1]!.body as WorkflowState['policy']; await publish();
  await page.getByRole('button', { name: 'Close navigation', exact: true }).click();
  await page.getByRole('button', { name: 'Open manager', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Process saved reports · paid', exact: true })).toBeDisabled();
  await page.getByText('Manager account, model, and limits', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Manager billing connection', exact: true }).selectOption('fixture-api');
  await page.getByRole('combobox', { name: 'Manager model', exact: true }).selectOption('fixture-economy-model');
  await page.getByLabel('Model context window (tokens)', { exact: true }).fill('16384');
  await page.getByLabel('Input price (USD per million tokens)', { exact: true }).fill('1');
  await page.getByLabel('Output price (USD per million tokens)', { exact: true }).fill('2');
  await page.getByLabel('Cached input price (USD per million tokens)', { exact: true }).fill('0.1');
  await page.getByLabel('Cache-write price (USD per million tokens)', { exact: true }).fill('0');
  await page.getByLabel('Official model price source', { exact: true }).fill('https://platform.openai.com/docs/pricing');
  await page.getByLabel('Price checked on', { exact: true }).fill('2026-09-14');
  await page.getByLabel('My quality-check evidence', { exact: true }).fill('Browser fixture attestation; no real model was evaluated.');
  await page.getByRole('checkbox', { name: 'I checked this model against the quality needed for these summaries', exact: true }).check();
  await page.getByLabel('Manager per-request limit (USD)', { exact: true }).fill('0.025');
  await page.getByRole('checkbox', { name: 'Turn on the manager with this account and these limits', exact: true }).check();
  await page.getByRole('button', { name: 'Save manager settings', exact: true }).click();
  await expect.poll(() => requests.length).toBe(3);
  expect(requests[2]).toMatchObject({ method: 'PATCH', body: { enabled: true, connectionId: 'fixture-api', requestBudgetMicroUsd: 25000, model: { model: 'fixture-economy-model', qualityStatus: 'user-attested', inputPerMillionMicroUsd: 1000000 } } });
  workflow.manager.config = requests[2]!.body as ManagerConfig; await publish();
  // UX-02: the Manager status line reads the saved config through the shared managerStatusLine helper.
  const managerStatusText = page.getByText('explicit only', { exact: false });
  await expect(managerStatusText).toBeVisible();
  // Scroll the line itself into view so the saved screenshot actually shows the sentence being asserted
  // above, rather than whatever the drawer happened to be scrolled to after filling the settings form.
  await managerStatusText.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `docs/assets/previews/manager-status-line-${testInfo.project.name}.png`, animations: 'disabled' });
  await page.getByRole('button', { name: 'Process saved reports · paid', exact: true }).click();
  await expect.poll(() => requests.length).toBe(4);
  expect(requests[3]).toMatchObject({ path: '/api/v1/workspaces/budget-workspace/manager/process', method: 'POST', body: {} });
  await expect(page.getByRole('button', { name: 'Process saved reports · paid', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Disable future manager summaries', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Disable future manager summaries', exact: true }).click();
  await expect.poll(() => requests.length).toBe(5);
  expect(requests[4]).toMatchObject({ method: 'PATCH', body: { ...workflow.manager.config, enabled: false } });
  workflow.manager.config.enabled = false; await publish();
  finishManagerProcess!();
  await expect(page.getByText('Manager request finished. Review its saved result and usage below.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Process saved reports · paid', exact: true })).toBeDisabled();
});

test('API monitoring separates source evidence from measured traffic and clears setup credentials', async ({ page, baseURL }) => {
  await installEventFixture(page);
  const snapshot = emptySnapshot('traffic-workspace', 'Traffic workshop');
  snapshot.state.repositories = [{ id: 'traffic-repo', name: 'Service project', description: 'Local checkout', language: 'TypeScript', branch: 'main', position: [-6, -4], color: '#6c8c91', source: 'local', localPath: String.raw`C:\fixture\service-project` }];
  snapshot.state.telemetry = { sources: [], inventories: [{ repoId: 'traffic-repo', endpoints: [{ id: 'endpoint-one', repoId: 'traffic-repo', method: 'GET', route: '/hello', framework: 'fastify', source: { path: 'src/server.ts', line: 12, hash: 'a'.repeat(64) }, confidence: 'declared', reason: null }], scannedAt: '2026-09-14T12:00:00Z', filesScanned: 3, coverage: 'partial', issues: ['Dynamic route registrations may be missing.'] }], spans: [], logs: [], metrics: [], metricCursors: [], seen: [], coverage: { rejected: 0, dropped: 0, lastReceivedAt: null } };
  const source: TelemetrySource = { id: 'telemetry-one', serviceId: 'service-one', repoId: 'traffic-repo', serviceName: 'backend-development', createdAt: '2026-09-14T12:00:00Z', status: 'unverified', lastReceivedAt: null };
  const traffic: ServiceTraffic = { serviceId: 'service-one', source: 'metrics', requestCount: 10, errorCount: 1, meanLatencyMs: 20, p50LatencyMs: 25, p95LatencyMs: 50, latencyKind: 'histogram-upper-bound', from: '2026-09-14T12:00:00Z', through: '2026-09-14T12:01:00Z', partial: true };
  await page.route('**/api/v1/session', async route => {
    const upstream = await route.fetch(); const body = await upstream.json();
    await route.fulfill({ response: upstream, json: { ...body, mode: 'private', user: { id: 'traffic-owner', login: 'fixture-owner', displayName: null, avatarUrl: null }, workspaces: [{ id: 'traffic-workspace', name: 'Traffic workshop', kind: 'personal' }] } });
  });
  await page.route('**/api/v1/workspaces/traffic-workspace/snapshot', route => route.fulfill({ json: snapshot }));
  await page.route('**/api/v1/workspaces/traffic-workspace/services', async route => {
    if (route.request().method() === 'GET') { await route.fulfill({ json: { sources: snapshot.state.telemetry!.sources, traffic: source.status === 'receiving' ? [traffic] : [], inventories: snapshot.state.telemetry!.inventories, coverage: snapshot.state.telemetry!.coverage } }); return; }
    expect(route.request().postDataJSON()).toEqual({ repoId: 'traffic-repo', serviceName: 'backend-development' });
    await route.fulfill({ json: { source, setup: { endpoint: `${baseURL}/fixture-otlp`, authorization: 'Bearer fixture-only-telemetry-credential', serviceName: source.serviceName, protocol: 'http/protobuf', compression: 'none' } } });
  });
  await page.goto('/');
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open connections', exact: true }).click();
  await page.getByRole('button', { name: 'API activity', exact: true }).click();
  await expect(page.getByText('No running services are connected. Source definitions alone cannot provide request counts or latency.', { exact: true })).toBeVisible();
  await page.getByText('Connect measured service activity', { exact: true }).click();
  await page.getByLabel('Running service name', { exact: true }).fill('backend-development');
  await page.getByRole('button', { name: 'Prepare service connection', exact: true }).click();
  const credential = page.getByLabel('One-time telemetry authorization', { exact: true });
  await expect(credential).toHaveAttribute('type', 'password');
  await expect(credential).toHaveValue('Bearer fixture-only-telemetry-credential');
  expect(await page.evaluate(() => Object.values(localStorage).join('\n'))).not.toContain('fixture-only-telemetry-credential');
  await page.getByRole('button', { name: 'Close and clear this setup', exact: true }).click();
  await expect(credential).toHaveCount(0);
  source.status = 'receiving'; source.lastReceivedAt = '2026-09-14T12:01:00Z';
  snapshot.state.telemetry!.sources = [source];
  snapshot.state.telemetry!.spans = [{ id: 'span-one', sourceId: source.id, serviceId: source.serviceId, repoId: source.repoId, traceId: '1'.repeat(32), spanId: '2'.repeat(16), parentSpanId: null, method: 'GET', route: '/hello', statusCode: 200, error: false, durationMs: 18.5, occurredAt: '2026-09-14T12:01:00Z', runId: null, sampling: 'sampled-observation' }];
  snapshot.cursor++; await page.evaluate(value => window.dispatchEvent(new CustomEvent('fixture-workspace-state', { detail: value })), snapshot);
  await expect(page.getByText('HTTP metrics', { exact: true })).toBeVisible();
  const measured = page.locator('.observation-card').filter({ has: page.getByText('backend-development', { exact: true }) });
  await expect(measured.locator('dl > div').filter({ has: page.getByText('Requests', { exact: true }) })).toContainText('10');
  await expect(measured).toContainText('Latency percentiles are histogram upper bounds.');
  await page.getByRole('button', { name: /GET.*\/hello.*fastify/ }).click();
  const evidence = page.getByRole('dialog', { name: 'API source evidence', exact: true });
  await expect(evidence).toBeVisible();
  await expect(evidence).toContainText('src/server.ts:12');
  await expect(evidence).toContainText('does not prove that an endpoint is running');
  await page.keyboard.press('Escape');
  await expect(evidence).toHaveCount(0);
  await expect(page.getByTestId('left-drawer')).toBeVisible();
  await page.getByRole('button', { name: /GET.*\/hello.*18.50 ms/ }).click();
  await expect(page.getByRole('dialog', { name: 'Sampled request evidence', exact: true })).toContainText('Not linked');
  await page.getByRole('button', { name: 'Close evidence', exact: true }).click();
  await expect(page.getByRole('button', { name: /GET.*\/hello.*18.50 ms/ })).toBeFocused();
  await page.getByRole('button', { name: 'Repositories', exact: true }).click();
  await page.locator('button.repo-card').filter({ hasText: 'Service project' }).click();
  await expect(page.getByTestId('room-context')).toBeVisible();
  await page.getByRole('button', { name: 'Repository details', exact: true }).click();
  await expect(page.getByTestId('right-drawer')).toContainText('Receiving · coverage is partial');
  await expect(page.getByTestId('right-drawer')).not.toContainText('Not instrumented');
});

test('coordination shows saved prerequisite reasons and refreshes advice without starting work', async ({ page }, testInfo) => {
  await installEventFixture(page);
  const snapshot = emptySnapshot('coordination-workspace', 'Coordination workshop');
  snapshot.state.repositories = [{ id: 'coordination-repo', name: 'Coordinated project', description: 'Fixture checkout', language: 'TypeScript', branch: 'main', position: [-6, -4], color: '#6c8c91', source: 'local', localPath: String.raw`C:\fixture\coordination-project` }];
  const draft: CreateRunDraft = { repoId: 'coordination-repo', dependencyTaskIds: [], tool: 'codex', connectionId: 'fixture-native-account', mode: 'subscription', objective: 'Review the shared format', acceptanceCriteria: ['The shared format is documented.'], model: 'fixture-model', price: null, maxTurns: 1, maxOutputTokens: 500, maxMinutes: 1, budgetMicroUsd: 0, acknowledgeSubscriptionLimits: true };
  const prerequisite: RunnerTask = { id: 'coordination-prerequisite', draft, baseCommit: 'a'.repeat(40), contextVersion: 0, contextBrief: 'Saved fixture context.', approvalHash: 'b'.repeat(64), status: 'awaiting_review', createdAt: '2026-09-14T11:00:00Z', approvedAt: '2026-09-14T11:01:00Z', runId: 'coordination-run' };
  const dependent: RunnerTask = { ...prerequisite, id: 'coordination-dependent', draft: { ...draft, objective: 'Use the shared format', dependencyTaskIds: [prerequisite.id] }, status: 'draft', createdAt: '2026-09-14T12:00:00Z', approvedAt: null, runId: null };
  snapshot.state.runner!.tasks = [prerequisite, dependent];
  snapshot.state.runner!.runs = [{ id: 'coordination-run', taskId: prerequisite.id, tool: 'codex', connectionId: draft.connectionId, mode: 'subscription', model: draft.model, price: null, status: 'awaiting_review', startedAt: '2026-09-14T11:01:00Z', finishedAt: '2026-09-14T11:02:00Z', worktreePath: String.raw`C:\fixture\coordination-worktree`, branch: 'task/format', contextVersion: 0, contextDelivery: 'provider-acknowledged', providerRequests: null, usage: null, message: 'Fixture report saved.', changedFiles: ['format.md'], reportId: 'coordination-report' }];
  let plan: CoordinationPlan = { ...emptyCoordination(snapshot), tasks: [
    { taskId: prerequisite.id, repoId: draft.repoId, state: 'human-review', dependencyTaskIds: [], issues: [{ code: 'awaiting-review', severity: 'block', message: 'The saved prerequisite result needs human review.', relatedTaskIds: [], evidence: ['report:coordination-report'] }] },
    { taskId: dependent.id, repoId: draft.repoId, state: 'waiting', dependencyTaskIds: [prerequisite.id], issues: [{ code: 'dependency-waiting', severity: 'block', message: 'Every prerequisite requires human acceptance before approval.', relatedTaskIds: [prerequisite.id], evidence: ['task:coordination-prerequisite:awaiting_review'] }] },
  ] };
  let reads = 0, unavailable = false;
  const writes: string[] = [], externalRequests: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).hostname !== '127.0.0.1') externalRequests.push(request.url()); });
  await page.route('**/api/v1/session', async route => {
    const response = await route.fetch(); const session = await response.json();
    await route.fulfill({ response, json: { ...session, mode: 'private', user: { id: 'coordination-owner', login: 'fixture-owner', displayName: null, avatarUrl: null }, workspaces: [{ id: snapshot.state.workspace.id, name: snapshot.state.workspace.name, kind: 'personal' }] } });
  });
  await page.route('**/api/v1/workspaces/coordination-workspace/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') { writes.push(path); await route.fulfill({ status: 400, json: { message: 'This fixture never starts work.' } }); return; }
    if (path.endsWith('/snapshot')) { await route.fulfill({ json: snapshot }); return; }
    if (path.endsWith('/coordination')) { reads++; await route.fulfill({ status: unavailable ? 503 : 200, json: unavailable ? { message: 'Fixture advice unavailable.' } : plan }); return; }
    await route.fulfill({ status: 404, json: { message: 'Unsupported fixture request.' } });
  });
  const publish = async () => { snapshot.cursor++; await page.evaluate(value => window.dispatchEvent(new CustomEvent('fixture-workspace-state', { detail: value })), snapshot); };
  await page.goto('/');
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open agents', exact: true }).click();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await expect(page.getByText('Task coordination · zero AI calls', { exact: true })).toBeVisible();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(reads).toBe(0);
  await page.getByText('Task coordination · zero AI calls', { exact: true }).click();
  const panel = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: 'Task coordination · zero AI calls' }) });
  await expect(panel).toContainText('0 active · 1 of 1 worker slots available');
  await expect(panel).toContainText('human review');
  await expect(panel).toContainText('Every prerequisite requires human acceptance before approval.');
  const waiting = panel.getByText('waiting', { exact: true });
  await waiting.scrollIntoViewIfNeeded();
  await expect(waiting).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('coordination-waiting.png') });
  expect(writes).toEqual([]);
  expect(reads).toBe(1);
  snapshot.state.activity.push({ id: 'unrelated-activity', message: 'An unrelated service activity was saved.', kind: 'system', createdAt: '2026-09-14T12:00:30Z' });
  await publish();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(waiting).toBeVisible();
  expect(reads).toBe(1);

  prerequisite.status = 'accepted';
  plan = { ...plan, tasks: [{ ...plan.tasks[0]!, state: 'closed', issues: [] }, { ...plan.tasks[1]!, issues: [{ code: 'stale-context', severity: 'block', message: 'Prerequisite evidence changed. Create and review a fresh draft with the accepted result.', relatedTaskIds: [prerequisite.id], evidence: ['draft:coordination-dependent'] }] }] };
  await publish();
  await expect(panel).toContainText('Prerequisite evidence changed. Create and review a fresh draft with the accepted result.');
  await expect(panel.getByText('waiting', { exact: true })).toBeVisible();
  await expect(panel).not.toContainText('suggested for your review');

  const fresh: RunnerTask = { ...dependent, id: 'coordination-fresh', contextBrief: 'Accepted prerequisite evidence was reviewed in this new draft.', approvalHash: 'c'.repeat(64), createdAt: '2026-09-14T12:01:00Z' };
  snapshot.state.runner!.tasks.push(fresh);
  plan = { ...plan, tasks: [...plan.tasks, { taskId: fresh.id, repoId: draft.repoId, state: 'reviewable', dependencyTaskIds: [prerequisite.id], issues: [{ code: 'duplicate-task', severity: 'review', message: 'An earlier draft has matching intent; review the fresh evidence before choosing which draft to approve.', relatedTaskIds: [dependent.id], evidence: [] }] }], suggestedTaskIds: [fresh.id] };
  await publish();
  const reviewable = panel.getByText('reviewable · suggested for your review', { exact: true });
  await reviewable.scrollIntoViewIfNeeded();
  await expect(reviewable).toBeInViewport();
  await expect(panel).toContainText('Each new task still needs your approval.');
  await page.screenshot({ path: testInfo.outputPath('coordination-advice.png') });
  unavailable = true; snapshot.state.manager.version++; await publish();
  await expect(panel).toContainText('Task coordination is unavailable. Approval still checks the saved dependencies, repository, and limits.');
  await expect(page.getByRole('heading', { name: 'Tasks and reviews', exact: true })).toBeVisible();
  expect(reads).toBeGreaterThanOrEqual(4); expect(writes).toEqual([]); expect(externalRequests).toEqual([]); expect(errors).toEqual([]);
});

test('managed task drafts require execution checks, exact approval, and separate final review', async ({ page }, testInfo) => {
  await installEventFixture(page);
  const snapshot = emptySnapshot('runner-workspace', 'Runner workshop');
  snapshot.state.repositories = [{ id: 'runner-repo', name: 'Task project', description: 'Local checkout', language: 'TypeScript', branch: 'main', position: [-6, -4], color: '#6c8c91', source: 'local', localPath: String.raw`C:\fixture\task-project` }];
  snapshot.state.workflow = { schemaVersion: 1, connections: [{ id: 'worker-api', provider: 'openai', mode: 'api', label: 'Fixed worker account', status: 'verified', createdAt: '2026-09-14T12:00:00Z', verifiedAt: '2026-09-14T12:00:00Z', accountIdentity: 'unavailable', models: ['gpt-5.4-mini-2026-03-17'], capabilities: { manager: true, managedExecution: true } }], defaults: { 'openai:api': 'worker-api' }, policy: { paidEnabled: true, dailyBudgetMicroUsd: 500000, managerDailyBudgetMicroUsd: 100000, maxRunBudgetMicroUsd: 100000, workerConcurrency: 1, timeZone: 'UTC' }, reservations: [], manager: { config: { enabled: false, connectionId: 'worker-api', model: { model: 'gpt-5.4-mini-2026-03-17', contextWindowTokens: 16384, inputPerMillionMicroUsd: 1000000, outputPerMillionMicroUsd: 2000000, cachedInputPerMillionMicroUsd: 100000, cacheWritePerMillionMicroUsd: 0, priceSource: 'https://platform.openai.com/docs/pricing', priceCheckedAt: '2026-09-14T00:00:00Z', qualityStatus: 'user-attested', qualityNote: 'Fixture record; no real model was evaluated.' }, maxInputTokens: 4096, maxOutputTokens: 800, requestBudgetMicroUsd: 25000 }, queueReportIds: [], jobs: [], versions: [], proposals: [], automaticStarts: [] } };
  let preflightReady = false;
  let draft: CreateRunDraft | undefined;
  const prerequisite: RunnerTask = { id: 'fixture-prerequisite', draft: { dependencyTaskIds: [], repoId: 'runner-repo', tool: 'openai-api', connectionId: 'worker-api', mode: 'api', objective: 'Define the reviewed greeting format', acceptanceCriteria: ['Greeting format is documented.'], model: 'gpt-5.4-mini-2026-03-17', price: snapshot.state.workflow.manager.config.model, maxTurns: 1, maxOutputTokens: 500, maxMinutes: 1, budgetMicroUsd: 50000, acknowledgeSubscriptionLimits: false }, baseCommit: 'a'.repeat(40), contextVersion: 0, contextBrief: 'Approved format evidence.', approvalHash: 'c'.repeat(64), status: 'accepted', createdAt: '2026-09-14T11:00:00Z', approvedAt: '2026-09-14T11:01:00Z', runId: null };
  snapshot.state.runner!.tasks = [prerequisite];
  const approvals: unknown[] = []; const reviews: unknown[] = [];
  await page.route('**/api/v1/session', async route => {
    const upstream = await route.fetch(); const body = await upstream.json();
    await route.fulfill({ response: upstream, json: { ...body, mode: 'private', user: { id: 'runner-owner', login: 'fixture-owner', displayName: null, avatarUrl: null }, workspaces: [{ id: 'runner-workspace', name: 'Runner workshop', kind: 'personal' }] } });
  });
  await page.route('**/api/v1/workspaces/runner-workspace/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/snapshot')) { await route.fulfill({ json: snapshot }); return; }
    if (path.endsWith('/coordination')) { expect(route.request().method()).toBe('GET'); await route.fulfill({ json: emptyCoordination(snapshot) }); return; }
    if (/\/agents\/[^/]+\/reports$/.test(path) && route.request().method() === 'GET') { await route.fulfill({ json: { reports: [], reportCount: 0, reportsNextOffset: null } }); return; }
    if (path.endsWith('/runner/preflight')) { expect(route.request().postDataJSON()).toEqual({ tool: 'openai-api', repoId: 'runner-repo' }); await route.fulfill({ json: { tool: 'openai-api', ready: preflightReady, checkedAt: new Date().toISOString(), checks: [{ name: 'Fixture sandbox boundary', passed: preflightReady, message: preflightReady ? 'Fixture execution check passed.' : 'Fixture execution boundary unavailable.' }] } }); return; }
    if (path.endsWith('/tasks')) draft = route.request().postDataJSON() as CreateRunDraft;
    if (path.endsWith('/approve')) approvals.push(route.request().postDataJSON());
    if (path.endsWith('/review')) reviews.push(route.request().postDataJSON());
    await route.fulfill({ json: { snapshot } });
  });
  const publish = async () => { snapshot.cursor++; await page.evaluate(value => window.dispatchEvent(new CustomEvent('fixture-workspace-state', { detail: value })), snapshot); };
  await page.goto('/');
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open agents', exact: true }).click();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByText('Prepare a new task', { exact: true }).click();
  await page.getByRole('button', { name: 'Check execution requirements', exact: true }).click();
  await expect(page.getByText('Execution is blocked', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create reviewable task draft', exact: true })).toBeDisabled();
  expect(draft).toBeUndefined();
  preflightReady = true;
  await page.getByRole('button', { name: 'Check execution requirements', exact: true }).click();
  await expect(page.getByText('Execution requirements passed', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Task model', exact: true }).selectOption('gpt-5.4-mini-2026-03-17');
  await page.getByRole('button', { name: 'Copy gpt-5.4-mini-2026-03-17 and its reviewed prices', exact: true }).click();
  await page.getByRole('checkbox', { name: 'I reviewed this model and its quality for this task', exact: true }).check();
  await page.getByRole('textbox', { name: 'Task objective', exact: true }).fill('Update the fixture greeting');
  await page.getByRole('textbox', { name: 'Acceptance criteria (one per line)', exact: true }).fill('Greeting matches the requirement\nRelevant tests pass');
  await page.getByText('Prerequisite tasks (optional)', { exact: true }).click();
  await page.getByRole('checkbox', { name: 'Define the reviewed greeting format · accepted', exact: true }).check();
  await page.getByLabel('Task API budget (USD)', { exact: true }).fill('0.05');
  await page.getByRole('button', { name: 'Create reviewable task draft', exact: true }).click();
  await expect.poll(() => !!draft).toBe(true);
  expect(draft).toMatchObject({ tool: 'openai-api', connectionId: 'worker-api', mode: 'api', budgetMicroUsd: 50000, model: 'gpt-5.4-mini-2026-03-17', dependencyTaskIds: ['fixture-prerequisite'] });
  expect(approvals).toEqual([]);
  const task: RunnerTask = { id: 'fixture-task', draft: draft!, baseCommit: 'a'.repeat(40), contextVersion: 0, contextBrief: 'Pinned prerequisite fixture-prerequisite: accepted greeting format. Acceptance does not integrate the worktree.', approvalHash: 'b'.repeat(64), status: 'draft', createdAt: '2026-09-14T12:00:00Z', approvedAt: null, runId: null };
  snapshot.state.runner!.tasks = [prerequisite, task]; await publish();
  await expect(page.getByRole('button', { name: 'Approve and start this task', exact: true })).toBeDisabled();
  const taskCard = page.locator('.managed-task').filter({ has: page.getByRole('heading', { name: 'Update the fixture greeting', exact: true }) });
  await taskCard.getByRole('button', { name: 'Open exact approval details', exact: true }).click();
  const evidence = page.getByRole('dialog', { name: 'Exact task approval details', exact: true });
  await expect(evidence).toContainText('b'.repeat(64)); await expect(evidence).toContainText('a'.repeat(40));
  await expect(evidence).toContainText('Define the reviewed greeting format');
  await expect(evidence).toContainText('Pinned prerequisite fixture-prerequisite');
  await expect(evidence).toContainText('Acceptance does not integrate the worktree.');
  await expect(evidence).toContainText('Checked 2026-09-14');
  await evidence.locator('.saved-context').scrollIntoViewIfNeeded();
  await expect(evidence.locator('.saved-context')).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('prerequisite-approval.png') });
  await page.getByRole('button', { name: 'Close evidence', exact: true }).click();
  await page.getByRole('checkbox', { name: 'I reviewed this exact task, account, model, and limits', exact: true }).check();
  await page.getByRole('button', { name: 'Approve and start this task', exact: true }).click();
  await expect.poll(() => approvals.length).toBe(1);
  expect(approvals[0]).toEqual({ approvalHash: 'b'.repeat(64) });
  task.status = 'awaiting_review'; task.runId = 'fixture-run';
  snapshot.state.runner!.runs = [{ id: 'fixture-run', taskId: task.id, tool: 'openai-api', connectionId: 'worker-api', mode: 'api', model: task.draft.model, price: task.draft.price, status: 'awaiting_review', startedAt: '2026-09-14T12:01:00Z', finishedAt: '2026-09-14T12:02:00Z', worktreePath: String.raw`C:\fixture\worktree`, branch: 'task/fixture', contextVersion: 0, contextDelivery: 'provider-acknowledged', providerRequests: 1, usage: null, message: null, changedFiles: ['src/greeting.ts'], reportId: 'fixture-report' }];
  await publish();
  await expect(page.getByText('Provider acknowledged v0', { exact: true })).toBeVisible();
  await expect(page.getByText('src/greeting.ts', { exact: true })).toBeVisible();
  expect(reviews).toEqual([]);
  await page.getByRole('button', { name: 'Accept reviewed result', exact: true }).click();
  await expect.poll(() => reviews.length).toBe(1);
  expect(reviews[0]).toEqual({ decision: 'accepted' });
  expect(approvals).toHaveLength(1);
  task.status = 'accepted';
  snapshot.state.agents = [{ id: 'fixture-run', name: 'Fixture worker', provider: 'Codex', role: 'Managed worker', repoId: 'runner-repo', task: task.draft.objective, activity: 'idle', color: '#6c8c91', home: [-5.4, -0.5], updatedAt: '2026-09-14T12:02:00Z', files: ['src/greeting.ts'], evidence: 'Fixture run evidence', contextVersion: 0 }];
  await publish();
  await page.getByRole('button', { name: 'Close navigation', exact: true }).click();
  await page.getByRole('button', { name: 'Open agents', exact: true }).click();
  await page.getByRole('button', { name: /Fixture worker.*OpenAI API worker/ }).click();
  const inspector = page.getByTestId('right-drawer');
  await expect(inspector).toContainText('Fixed worker account · api');
  await expect(inspector).toContainText('worker-api');
  await expect(inspector).toContainText('task/fixture');
  await expect(inspector).toContainText('Provider acknowledged v0');
  await expect(inspector.getByText('External · unavailable', { exact: true })).toHaveCount(0);
  snapshot.state.manager.version = 1;
  snapshot.state.manager.brief = 'A newer processed fixture brief.';
  snapshot.state.handoffs = [{ id: 'fixture-report', agentId: 'fixture-run', repoId: 'runner-repo', summary: 'The worker saved its result.', createdAt: '2026-09-14T12:02:00Z', status: 'processed', contextVersion: 1, delivery: 'unsupported' }];
  await publish();
  await page.getByRole('button', { name: 'Open saved manager report', exact: true }).click();
  await expect(inspector).toContainText('1 managed run acknowledged · v0');
  await expect(inspector).toContainText('Approved run context: Provider acknowledged v0');
  await expect(inspector).toContainText('Brief v1 delivery to the reporting agent: Unsupported');
  await expect(inspector).not.toContainText('Provider acknowledged v1');
  await inspector.locator('.drawer-content').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: testInfo.outputPath('manager-context-versions.png') });
  snapshot.state.runner!.subscriptions = [{ id: 'native-subscription', label: 'Native fixture account', status: 'verified', createdAt: '2026-09-14T12:00:00Z', accountLabel: 'Fixture native account', accountFingerprint: 'fixture-only', models: ['fixture-native-model'] }];
  snapshot.state.runner!.subscriptionDefault = 'native-subscription';
  const subscriptionTask: RunnerTask = { ...task, id: 'native-task', status: 'draft', runId: null, draft: { ...task.draft, tool: 'codex', mode: 'subscription', objective: 'Review native subscription limits', connectionId: 'native-subscription', model: 'fixture-native-model', price: null, maxTurns: 1, budgetMicroUsd: 0, acknowledgeSubscriptionLimits: true } };
  snapshot.state.runner!.tasks.push(subscriptionTask); await publish();
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  if (!(await page.getByRole('button', { name: 'Tasks', exact: true }).count())) await page.getByRole('button', { name: 'Open agents', exact: true }).click();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByText('Prepare a new task', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Managed worker tool', exact: true }).selectOption('codex');
  await expect(page.getByRole('spinbutton', { name: 'Native outer turns', exact: true })).toHaveValue('1');
  await expect(page.getByRole('spinbutton', { name: 'Native outer turns', exact: true })).toBeDisabled();
  await expect(page.getByRole('spinbutton', { name: 'Maximum task output tokens per request', exact: true })).toHaveCount(0);
  const nativeCard = page.locator('.managed-task').filter({ hasText: 'Review native subscription limits' });
  await expect(nativeCard).toContainText('Native allowance · local cap unavailable');
  await expect(nativeCard).toContainText('1 outer turn');
  await expect(nativeCard).not.toContainText('output tokens/request');
  await nativeCard.getByRole('button', { name: 'Open exact approval details', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Exact task approval details', exact: true })).toContainText('Native allowance · local cap unavailable');
  await expect(page.getByRole('dialog', { name: 'Exact task approval details', exact: true })).not.toContainText('output tokens/request');
  await page.screenshot({ path: testInfo.outputPath('native-task-approval.png') });
  expect(approvals).toHaveLength(1);
});

// ---------------------------------------------------------------------------------------------------------------------
// CH-02 (the Tasks drawer stops guessing, keeps what you typed and says why nothing can start) and UX-03 (signing out or
// switching account clears everything private on screen). One draft store (apps/web/src/draftStore.ts) keeps the typed text
// outside App's state; resetPrivateState() clears it for sign-out, an account change and a workspace change, and keeps it,
// hidden, when a session simply expires (decision D72). Fixtures only: no real account, service data or model is involved.
// ---------------------------------------------------------------------------------------------------------------------

function gitProject(id: string, name: string, slot: number): Repository {
  return { id, name, description: 'Local checkout', language: 'TypeScript', branch: 'main', position: [-6 + slot * 4, -4], color: '#6c8c91', source: 'local', localPath: `C:\\fixture\\${id}` };
}

function taskWorkflow(withAccount: boolean, proposals: WorkflowState['manager']['proposals'] = []): WorkflowState {
  return { schemaVersion: 1, connections: withAccount ? [{ id: 'worker-api', provider: 'openai', mode: 'api', label: 'Fixed worker account', status: 'verified', createdAt: '2026-09-14T12:00:00Z', verifiedAt: '2026-09-14T12:00:00Z', accountIdentity: 'unavailable', models: ['gpt-5.4-mini-2026-03-17'], capabilities: { manager: true, managedExecution: true } }] : [],
    defaults: withAccount ? { 'openai:api': 'worker-api' } : {}, policy: { paidEnabled: false, dailyBudgetMicroUsd: 0, managerDailyBudgetMicroUsd: 0, maxRunBudgetMicroUsd: 0, workerConcurrency: 1, timeZone: 'UTC' }, reservations: [],
    manager: { config: { enabled: false, connectionId: null, model: null, maxInputTokens: 4096, maxOutputTokens: 800, requestBudgetMicroUsd: 0 }, queueReportIds: [], jobs: [], versions: [], proposals, automaticStarts: [] } };
}

/** A private workspace whose only writes are the ones a test lists: the check is blocked, and anything else is refused. */
async function routeTasksWorkspace(page: Page, snapshot: Snapshot, writes: { path: string; body: unknown }[]) {
  const id = snapshot.state.workspace.id;
  await page.route('**/api/v1/session', async route => {
    const upstream = await route.fetch(); const body = await upstream.json();
    await route.fulfill({ response: upstream, json: { ...body, mode: 'private', user: { id: 'tasks-owner', login: 'fixture-owner', displayName: null, avatarUrl: null }, workspaces: [{ id, name: snapshot.state.workspace.name, kind: 'personal' }] } });
  });
  await page.route(`**/api/v1/workspaces/${id}/**`, async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    if (path.endsWith('/snapshot')) { await route.fulfill({ json: snapshot }); return; }
    if (path.endsWith('/coordination')) { await route.fulfill({ json: emptyCoordination(snapshot) }); return; }
    if (/\/agents\/[^/]+\/reports$/.test(path) && method === 'GET') { await route.fulfill({ json: { reports: [], reportCount: 0, reportsNextOffset: null } }); return; }
    if (path.endsWith('/runner/preflight')) {
      const body = route.request().postDataJSON() as { tool: string; repoId: string };
      writes.push({ path, body });
      await route.fulfill({ json: { tool: body.tool, ready: false, checkedAt: new Date().toISOString(), checks: [{ name: 'Fixture sandbox boundary', passed: false, message: 'Fixture execution boundary unavailable.' }, { name: 'Fixture transport', passed: true, message: 'Fixture transport is fine.' }] } }); return;
    }
    if (method !== 'GET') writes.push({ path, body: route.request().postDataJSON() });
    await route.fulfill({ status: 404, json: { message: 'Unsupported fixture request.' } });
  });
}

async function openTasks(page: Page) { await page.getByRole('button', { name: 'Open tasks', exact: true }).click(); }
const workspacePublisher = (page: Page, snapshot: Snapshot) => async () => { snapshot.cursor++; await page.evaluate(value => window.dispatchEvent(new CustomEvent('fixture-workspace-state', { detail: value })), snapshot); };

test('the Tasks form never guesses the project, keeps what you typed through Escape, Close and a resize, and leads a blocked check with a plain sentence', async ({ page }, testInfo) => {
  await installEventFixture(page);
  const snapshot = emptySnapshot('tasks-workspace', 'Tasks workshop');
  snapshot.state.repositories = [gitProject('billing-repo', 'Billing project', 0), gitProject('search-repo', 'Search project', 1)];
  snapshot.state.workflow = taskWorkflow(true);
  const writes: { path: string; body: unknown }[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await routeTasksWorkspace(page, snapshot, writes);
  await page.goto('/');
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  await openTasks(page);
  await expect(page.getByRole('heading', { name: 'Managed tasks', exact: true })).toBeVisible();
  await expect(page.getByText('The check starts no task and makes no model request; it may run local sandbox probes.', { exact: true })).toBeVisible();

  // Nothing is pre-selected when there is a choice (D38): a blank form starts on "Choose a project".
  await page.getByText('Prepare a new task', { exact: true }).click();
  const project = page.getByRole('combobox', { name: 'Task repository', exact: true });
  const objective = page.getByRole('textbox', { name: 'Task objective', exact: true });
  const criteria = page.getByRole('textbox', { name: 'Acceptance criteria (one per line)', exact: true });
  await expect(project).toHaveValue('');
  await expect(project.locator('option:checked')).toHaveText('Choose a project');
  await expect(project.locator('option')).toHaveText(['Choose a project', 'Billing project', 'Search project']);
  await expect(page.getByRole('button', { name: 'Check execution requirements', exact: true })).toBeDisabled();

  // Changing the project never remounts the form or clears what was typed.
  await objective.fill('Add a retry to the search index job');
  await criteria.fill('The job retries twice\nA failed retry is reported');
  await objective.evaluate(element => { (element as HTMLTextAreaElement & { keptNode?: string }).keptNode = 'same textarea'; });
  await project.selectOption('search-repo');
  await expect(objective).toHaveValue('Add a retry to the search index job');
  await expect(criteria).toHaveValue('The job retries twice\nA failed retry is reported');
  expect(await objective.evaluate(element => (element as HTMLTextAreaElement & { keptNode?: string }).keptNode)).toBe('same textarea');
  await expect(page.getByText('Kept in this browser tab only, not saved to disk. Signing out clears it.', { exact: true })).toBeVisible();
  await criteria.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('tasks-kept-text.png') });

  const expectKept = async () => {
    await expect(objective).toBeVisible(); // kept text opens the form on its own
    await expect(objective).toHaveValue('Add a retry to the search index job');
    await expect(criteria).toHaveValue('The job retries twice\nA failed retry is reported');
    await expect(project).toHaveValue('search-repo');
  };
  // Escape, then Close, then a resize across the 900 px breakpoint: the text survives each one.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('left-drawer')).toHaveCount(0);
  await openTasks(page); await expectKept();
  await page.getByRole('button', { name: 'Close navigation', exact: true }).click();
  await expect(page.getByTestId('left-drawer')).toHaveCount(0);
  await openTasks(page); await expectKept();
  const original = page.viewportSize()!;
  await page.setViewportSize({ width: original.width >= 900 ? 700 : 1200, height: original.height });
  await expectKept();
  await page.setViewportSize(original);
  await expectKept();

  // A blocked check leads with a plain sentence, then lists the raw checks. Nothing starts and no draft is saved.
  await page.getByRole('button', { name: 'Check execution requirements', exact: true }).click();
  await expect(page.getByText('Execution is blocked', { exact: true })).toBeVisible();
  const blocked = page.locator('.preflight-results');
  await expect(blocked.getByText('Agent Town cannot run this task on this computer yet. No task was started and no model request was made. The checks below show what did not pass.', { exact: true })).toBeVisible();
  expect(await blocked.evaluate(element => [...element.children].map(child => child.tagName))).toEqual(['STRONG', 'P', 'UL']);
  await expect(blocked.getByText('Blocked · Fixture sandbox boundary', { exact: true })).toBeVisible();
  await expect(blocked.getByText('Fixture execution boundary unavailable.', { exact: true })).toBeVisible();
  await expect(blocked.getByText('Passed · Fixture transport', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create reviewable task draft', exact: true })).toBeDisabled();
  expect(writes.map(write => write.path.split('/').slice(-2).join('/'))).toEqual(['runner/preflight']);
  expect(writes[0]?.body).toEqual({ tool: 'openai-api', repoId: 'search-repo' });
  await blocked.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('tasks-blocked.png') });
  expect(errors).toEqual([]);
});

test('a Tasks panel with no eligible project or no account offers a working next step instead of only text', async ({ page }, testInfo) => {
  await installEventFixture(page);
  const snapshot = emptySnapshot('tasks-workspace', 'Tasks workshop');
  snapshot.state.workflow = taskWorkflow(false);
  const writes: { path: string; body: unknown }[] = [];
  await routeTasksWorkspace(page, snapshot, writes);
  const publish = workspacePublisher(page, snapshot);
  await page.goto('/');
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();

  // No project at all: the button opens the Repositories drawer.
  await openTasks(page);
  await expect(page.getByText('Connect a local Git repository before preparing a managed task.', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('tasks-no-project.png') });
  await page.getByRole('button', { name: 'Connect a project', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Repositories', level: 2 })).toBeVisible();
  await expect(page.getByText('Connect a local Git repository before preparing a managed task.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Repositories', exact: true })).toBeFocused(); // the button that was pressed is gone: focus stays in the drawer

  // Only a plain folder (no Git history): the same next step, and the honest reason.
  snapshot.state.repositories = [{ ...gitProject('plain-folder', 'Notes folder', 0), projectKind: 'folder', branch: 'Not applicable' }];
  await publish();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await expect(page.getByText(/Connected project folders support agent observation\. Managed tasks require an existing Git repository/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect a project', exact: true })).toBeVisible();

  // One Git project and no verified account: the project is selected (there is no choice to make), and the account gap has a button.
  snapshot.state.repositories = [gitProject('only-repo', 'Only project', 0)];
  await publish();
  await expect(page.getByRole('button', { name: 'Connect a project', exact: true })).toHaveCount(0);
  await page.getByText('Prepare a new task', { exact: true }).click();
  const project = page.getByRole('combobox', { name: 'Task repository', exact: true });
  await expect(project).toHaveValue('only-repo');
  await expect(project.locator('option')).toHaveText(['Only project']);
  await expect(page.getByRole('button', { name: 'Check execution requirements', exact: true })).toBeEnabled();
  await expect(page.getByText('No verified account for this worker yet. Add one in Connections. Adding an account starts no task.', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Managed worker tool', exact: true }).selectOption('codex');
  await expect(page.getByText('No verified Codex subscription account yet. Add one in Connections. Adding an account starts no task.', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Managed worker tool', exact: true }).selectOption('openai-api');
  await page.getByRole('button', { name: 'Open Connections', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('tasks-no-account.png') });
  await page.getByRole('button', { name: 'Open Connections', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connections', level: 2 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connections', exact: true })).toBeFocused();

  // Once an account is verified the notice is gone.
  snapshot.state.workflow = taskWorkflow(true);
  await publish();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByText('Prepare a new task', { exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Task billing connection', exact: true }).locator('option')).toHaveText(['Choose a verified connection', 'Fixed worker account · api']);
  await expect(page.getByRole('button', { name: 'Open Connections', exact: true })).toHaveCount(0);
  expect(writes).toEqual([]); // the buttons only navigate: no check, no draft, no request
});

test('typing in the Tasks draft does not redraw the 3D scene', async ({ page }) => {
  // Counts commits in which the World component actually rendered, through React's own devtools hook (no change to the app).
  // World is not memoized, so any App-level state change that a keystroke caused would redraw the whole scene (UX-23: 15.6 ms each).
  await page.addInitScript(() => {
    const counts = { world: 0 }; let domRenderer = -1, nextRenderer = 1;
    (window as unknown as { __worldRenders: typeof counts }).__worldRenders = counts;
    type Fiber = { flags: number; type: unknown; memoizedProps: Record<string, unknown> | null; child: Fiber | null; sibling: Fiber | null; alternate: Fiber | null };
    // Like React DevTools: only subtrees whose first child changed were touched by this commit (flags on an untouched fiber are stale),
    // and inside a touched subtree PerformedWork (flag 1) means the function component really rendered rather than bailed out.
    const visit = (next: Fiber, prev: Fiber | null) => {
      const props = next.memoizedProps;
      if (typeof next.type === 'function' && props && 'snapshotGeneration' in props && 'labelsInteractive' in props && (!prev || (next.flags & 1) === 1)) counts.world++;
      if (next.child !== (prev?.child ?? null)) for (let child = next.child; child; child = child.sibling) visit(child, child.alternate);
    };
    (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true, isDisabled: false, renderers: new Map(),
      inject(internals: { rendererPackageName?: string }) { const id = nextRenderer++; if (internals?.rendererPackageName === 'react-dom') domRenderer = id; return id; },
      onCommitFiberRoot(id: number, root: { current: Fiber }) { if (id === domRenderer) visit(root.current, root.current.alternate); },
      onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {}, on() {}, off() {}, sub() { return () => {}; },
    };
  });
  await installEventFixture(page);
  const snapshot = emptySnapshot('tasks-workspace', 'Tasks workshop');
  snapshot.state.repositories = [gitProject('billing-repo', 'Billing project', 0), gitProject('search-repo', 'Search project', 1)];
  snapshot.state.workflow = taskWorkflow(true);
  await routeTasksWorkspace(page, snapshot, []);
  const publish = workspacePublisher(page, snapshot);
  await page.goto('/');
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  await openTasks(page);
  await page.getByText('Prepare a new task', { exact: true }).click();
  await expect(page.locator('canvas'), 'the 3D scene must be running for its redraws to be counted').toHaveCount(1);
  const worldRenders = () => page.evaluate(() => (window as unknown as { __worldRenders: { world: number } }).__worldRenders.world);

  // The counter must be able to see a redraw: a saved-state update from the service redraws the world.
  const first = await worldRenders();
  await publish();
  await expect.poll(worldRenders).toBeGreaterThan(first);

  const settled = await worldRenders();
  await page.getByRole('textbox', { name: 'Task objective', exact: true }).pressSequentially('Typing a long objective must not redraw the world.');
  await page.getByRole('textbox', { name: 'Acceptance criteria (one per line)', exact: true }).pressSequentially('First criterion\nSecond criterion\nThird criterion');
  await page.getByRole('combobox', { name: 'Task repository', exact: true }).selectOption('billing-repo');
  // Anything that redraws per keystroke adds one render for each of these ~90 keystrokes. The service-free 10 s clock tick can add one.
  expect((await worldRenders()) - settled).toBeLessThanOrEqual(1);
  await expect(page.getByRole('textbox', { name: 'Task objective', exact: true })).toHaveValue('Typing a long objective must not redraw the world.');
});

// UX-03: A leaves private work on screen, the person signs out (or the session ends, or the account flips), and B signs in in the same tab.
type Who = 'a' | 'b' | 'nobody';
type Actor = { user: NonNullable<BrowserSession['user']>; workspace: { id: string; name: string; kind: 'personal' }; snapshot: Snapshot };
function accountActor(tag: 'a' | 'b'): Actor {
  const upper = tag.toUpperCase();
  const snapshot = emptySnapshot(`ws-${tag}`, `${upper} workspace`);
  snapshot.state.repositories = [gitProject(`${tag}-repo`, `${upper} billing project`, 0)];
  snapshot.state.workflow = taskWorkflow(true, tag === 'a' ? [{ id: 'proposal-a', sourceJobId: 'job-a', repoId: 'a-repo', title: 'A-PRIVATE rotate the Acme production credentials', acceptanceCriteria: ['A-PRIVATE criterion: the old credentials stop working'], status: 'proposed', createdAt: '2026-09-24T09:00:00Z' }] : []);
  snapshot.state.agents = [{ id: `${tag}-worker`, name: `${upper} worker`, provider: 'Codex', role: 'Managed worker', repoId: `${tag}-repo`, task: `${upper} fixture task`, activity: 'idle', color: '#6c8c91', home: [-5.4, -0.5], updatedAt: '2026-09-24T09:00:00Z', files: [], evidence: 'Fixture agent', contextVersion: 0 }];
  return { user: { id: `owner-${tag}`, login: `owner-${tag}`, displayName: `${upper} owner`, avatarUrl: null }, workspace: { id: `ws-${tag}`, name: `${upper} workspace`, kind: 'personal' }, snapshot };
}

async function routeAccounts(page: Page, actors: Record<'a' | 'b', Actor>, control: { who: Who; expired: boolean; signingInAs: Who; writes: string[] }) {
  let base: BrowserSession | undefined;
  const sessionFor = (who: Who): BrowserSession => ({ ...base!, mode: 'private', csrf: `csrf-${who}`, identity: { configured: true }, user: who === 'nobody' ? null : actors[who].user, workspaces: who === 'nobody' ? [] : [actors[who].workspace] });
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    if (path === '/api/v1/session') { const upstream = await route.fetch(); base = await upstream.json() as BrowserSession; await route.fulfill({ response: upstream, json: sessionFor(control.who) }); return; }
    if (path === '/api/v1/auth/logout') { control.who = 'nobody'; await route.fulfill({ json: sessionFor('nobody') }); return; }
    if (path === '/api/v1/auth/github/device/start') { await route.fulfill({ json: { flowId: 'flow-fixture', userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device', expiresAt: new Date(Date.now() + 600000).toISOString(), intervalSeconds: 5 } }); return; }
    if (path === '/api/v1/auth/github/device/poll') { control.who = control.signingInAs; await route.fulfill({ json: { status: 'authorized', session: sessionFor(control.who) } }); return; }
    const workspace = /^\/api\/v1\/workspaces\/ws-([ab])\/(.+)$/.exec(path);
    if (!workspace) { await route.continue(); return; }
    const owner = actors[workspace[1] as 'a' | 'b'], rest = workspace[2]!;
    if (rest === 'snapshot') {
      if (control.expired) { await route.fulfill({ status: 401, json: { code: 'SESSION_REQUIRED', message: 'Reconnect to Agent Town and sign in again if needed.' } }); return; }
      await route.fulfill({ json: owner.snapshot }); return;
    }
    if (rest === 'coordination') { await route.fulfill({ json: emptyCoordination(owner.snapshot) }); return; }
    if (/^agents\/[^/]+\/reports$/.test(rest) && method === 'GET') { await route.fulfill({ json: { reports: [], reportCount: 0, reportsNextOffset: null } }); return; }
    if (method !== 'GET') control.writes.push(`${method} ${path}`);
    await route.fulfill({ status: 404, json: { message: 'Unsupported fixture request.' } });
  });
}

const isWide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900;
const changeIdentity = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('online'))); // the app re-reads its session and workspace, as it does when the connection returns

/** A leaves private work on screen: a manager proposal turned into a Tasks draft and edited, an agent search, and (with room for two drawers) a selected, followed agent. */
async function leavePrivateWork(page: Page, from: 'proposal' | 'blank') {
  const objective = page.getByRole('textbox', { name: 'Task objective', exact: true });
  if (from === 'proposal') {
    await page.getByRole('button', { name: 'Open manager', exact: true }).click();
    await page.getByRole('button', { name: 'Create task draft', exact: true }).click();
    await expect(objective).toHaveValue('A-PRIVATE rotate the Acme production credentials');
  } else {
    await openTasks(page);
    await page.getByText('Prepare a new task', { exact: true }).click();
  }
  await objective.fill('A-PRIVATE rotate the Acme production credentials, then revoke the old ones');
  await page.getByRole('textbox', { name: 'Acceptance criteria (one per line)', exact: true }).fill('A-PRIVATE criterion one\nA-PRIVATE criterion two');
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page.getByRole('textbox', { name: 'Find an agent', exact: true }).fill('A worker');
  await expect(page.locator('.agent-row')).toHaveCount(1);
  if (isWide(page)) { // a narrow screen shows one drawer at a time, so a selection cannot stay open beside the sign-out control
    await page.locator('.agent-row').first().click();
    const follow = page.getByRole('button', { name: 'Follow this agent', exact: true });
    if (await follow.isEnabled()) { // following needs the 3D world; without WebGL the List view has no camera to follow with
      await follow.click();
      await expect(page.getByRole('button', { name: /Following agent/ })).toBeVisible();
    }
  }
}

async function openTab(page: Page, label: 'Agents' | 'Tasks') {
  if (await page.getByTestId('left-drawer').count()) await page.getByRole('button', { name: label, exact: true }).click();
  else await openSectionFromDock(page, label);
}
const openSectionFromDock = (page: Page, label: 'Agents' | 'Tasks') => page.getByRole('button', { name: `Open ${label.toLowerCase()}`, exact: true }).click();

/** No selection, no follow mode and no search left on screen. (Follow mode is per account: the same agent, opened again, is not being followed.) */
async function expectNoLeftoverSelection(page: Page) {
  await expect(page.getByTestId('right-drawer')).toHaveCount(0);
  await openTab(page, 'Agents');
  await expect(page.getByRole('textbox', { name: 'Find an agent', exact: true })).toHaveValue('');
  if (isWide(page)) {
    await page.locator('.agent-row').first().click();
    await expect(page.getByRole('button', { name: 'Follow this agent', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close details', exact: true }).click();
    await expect(page.getByTestId('right-drawer')).toHaveCount(0);
  }
}

/** Nothing the last person left on screen is there: no selection, no follow mode, no search, no proposal, no unsent Tasks text. */
async function expectNoPrivateLeftovers(page: Page, ownProject: 'a-repo' | 'b-repo') {
  await expectNoLeftoverSelection(page);
  await openTab(page, 'Tasks');
  await page.getByText('Prepare a new task', { exact: true }).click(); // a form with kept text would already be open, and this would close it
  await expect(page.getByRole('textbox', { name: 'Task objective', exact: true })).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Acceptance criteria (one per line)', exact: true })).toHaveValue('');
  await expect(page.getByRole('combobox', { name: 'Task repository', exact: true })).toHaveValue(ownProject); // the signed-in account's one project, never the last person's
  await expect(page.locator('body')).not.toContainText('A-PRIVATE');
}

for (const next of ['b', 'a'] as const) {
  test(`signing out clears the proposal, search, selection, follow mode and unsent Tasks text before ${next === 'b' ? 'the next account' : 'the same account'} signs in`, async ({ page }, testInfo) => {
    test.setTimeout(60000);
    const actors = { a: accountActor('a'), b: accountActor('b') };
    const control = { who: 'a' as Who, expired: false, signingInAs: next as Who, writes: [] as string[] };
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await installEventFixture(page);
    await routeAccounts(page, actors, control);
    await page.goto('/');
    await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
    await leavePrivateWork(page, 'proposal');

    await page.getByRole('button', { name: 'Connections', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out of GitHub', exact: true }).click();
    // The Connections drawer is the sign-in surface: it stays open (WS1-02), and nothing of A's is on the page while nobody is signed in.
    await expect(page.getByRole('button', { name: 'Sign in with GitHub', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Connections', level: 2 })).toBeVisible();
    await expect(page.getByTestId('right-drawer')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('A-PRIVATE');
    await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click();
    await expect(page.getByText('ABCD-EFGH', { exact: true })).toBeVisible();
    await expect(page.getByText(`Signed in as ${next.toUpperCase()} owner.`, { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.workspace-pill')).toContainText(`${next.toUpperCase()} workspace`);
    // Signing back in as the same person does not bring an explicit sign-out's drafts back either.
    await expect(page.getByRole('heading', { name: 'Connections', level: 2 })).toBeVisible();

    await expectNoPrivateLeftovers(page, next === 'a' ? 'a-repo' : 'b-repo');
    await page.screenshot({ path: testInfo.outputPath(`signed-out-then-${next}.png`) });
    expect(control.writes).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('switching straight from account A to account B, with no sign-out, clears the same private state', async ({ page }) => {
  const actors = { a: accountActor('a'), b: accountActor('b') };
  const control = { who: 'a' as Who, expired: false, signingInAs: 'b' as Who, writes: [] as string[] };
  await installEventFixture(page);
  await routeAccounts(page, actors, control);
  await page.goto('/');
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  await leavePrivateWork(page, 'proposal');
  control.who = 'b';
  await changeIdentity(page);
  await expect(page.locator('.workspace-pill')).toContainText('B workspace');
  await expect(page.getByTestId('left-drawer')).toHaveCount(0); // a private drawer never reopens on B's data
  await expectNoPrivateLeftovers(page, 'b-repo');
  expect(control.writes).toEqual([]);
});

for (const next of ['a', 'b'] as const) {
  test(`an expired session closes private drawers and clears what was on screen, keeps unsent Tasks text hidden, and ${next === 'a' ? 'returns it to the same person' : 'never shows it to another account'} (D72)`, async ({ page }, testInfo) => {
    test.setTimeout(60000);
    const actors = { a: accountActor('a'), b: accountActor('b') };
    const control = { who: 'a' as Who, expired: false, signingInAs: next as Who, writes: [] as string[] };
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await installEventFixture(page);
    await routeAccounts(page, actors, control);
    await page.goto('/');
    await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
    await leavePrivateWork(page, 'blank');

    // The session ends by itself (8-hour expiry, a restart): the workspace snapshot is refused and the session is anonymous again.
    control.expired = true; control.who = 'nobody';
    await changeIdentity(page);
    await expect(page.getByRole('region', { name: 'Welcome to Agent Town', exact: true })).toBeVisible();
    await expect(page.getByTestId('left-drawer')).toHaveCount(0);
    await expect(page.getByTestId('right-drawer')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('A-PRIVATE');

    control.expired = false;
    await page.getByRole('button', { name: 'Set up your workspace', exact: true }).click();
    await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click();
    await expect(page.getByText('ABCD-EFGH', { exact: true })).toBeVisible();
    await expect(page.getByText(`Signed in as ${next.toUpperCase()} owner.`, { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.workspace-pill')).toContainText(`${next.toUpperCase()} workspace`);
    await page.screenshot({ path: testInfo.outputPath(`expired-then-${next}.png`) });

    if (next === 'a') {
      // The same owner in the same workspace: the unsent text is back, and the search, selection and follow mode are not.
      await expectNoLeftoverSelection(page);
      await openTab(page, 'Tasks');
      await expect(page.getByRole('textbox', { name: 'Task objective', exact: true })).toHaveValue('A-PRIVATE rotate the Acme production credentials, then revoke the old ones');
      await expect(page.getByRole('textbox', { name: 'Acceptance criteria (one per line)', exact: true })).toHaveValue('A-PRIVATE criterion one\nA-PRIVATE criterion two');
    } else {
      await expectNoPrivateLeftovers(page, 'b-repo');
    }
    expect(control.writes).toEqual([]);
    expect(errors).toEqual([]);
  });
}
