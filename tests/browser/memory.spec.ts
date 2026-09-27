import { expect, test, type Page } from '@playwright/test';
import type { BrowserSession, Snapshot } from '@agent-town/contracts';
import { getModelProfile, profilePrice } from '@agent-town/contracts';
import { initialWorkflow } from '../../apps/service/src/workflow/budget';
import { applyMemoryAction, contextMemory } from '../../apps/service/src/workflow/memory';
import { managerQueueStatus } from '../../apps/service/src/workflow/queue';

async function fixture(page: Page) {
  await page.addInitScript(() => {
    class FixtureEvents extends EventTarget {
      onopen: (() => void) | null = null; onerror: (() => void) | null = null;
      handler = (event: Event) => this.dispatchEvent(new MessageEvent('state', { data: JSON.stringify((event as CustomEvent).detail) }));
      constructor() { super(); window.addEventListener('memory-fixture', this.handler); setTimeout(() => this.onopen?.(), 0); }
      close() { window.removeEventListener('memory-fixture', this.handler); }
    }
    window.EventSource = FixtureEvents as unknown as typeof EventSource;
  });
  const at = new Date().toISOString(), workflow = initialWorkflow();
  const state: Snapshot['state'] = { schemaVersion: 1, workspace: { id: 'memory-private', name: 'Memory fixture', mode: 'private' }, workflow,
    repositories: [{ id: 'repo', name: 'Fixture repo', description: '', branch: 'main', color: '#aaa', language: 'TypeScript', position: [-6, -4] }],
    agents: [], runner: { schemaVersion: 1, tasks: [], runs: [], subscriptions: [], subscriptionDefault: null }, activity: [], simulation: { running: false, step: 0 },
    manager: { version: 0, brief: 'The report is saved. No model was called.', updatedAt: at }, handoffs: [{ id: 'report-failure', agentId: 'run-failure', repoId: 'repo', summary: 'The fixture worker failed; no passing checks were recorded.', createdAt: at, status: 'saved', contextVersion: null, delivery: 'unsupported',
      details: { outcome: 'failed', taskId: 'task-failure', runId: 'run-failure', sourceEventId: 'run-failure:finished', occurredAt: at, contextVersionUsed: 0, baseCommit: null, branch: null, worktreePath: null, files: { status: 'unavailable', paths: [] }, checks: [{ name: 'npm test', result: 'unavailable', evidence: 'unavailable', reference: null }], decisions: [], assumptions: [], remainingWork: ['Review before retry.'], evidenceRefs: ['run-failure:finished'], limitations: ['Test execution evidence was not supplied.'] } }] };
  applyMemoryAction(state, { action: 'open-blocker', expectedVersion: 0, text: 'Login evidence is missing.', repoId: 'repo', sourceReportIds: ['report-failure'] }, 'fixture-blocker', at);
  const snapshot: Snapshot = { cursor: 1, state };
  const session: BrowserSession = { csrf: 'fixture-csrf', mode: 'private', user: { id: 'owner', login: 'owner', displayName: 'Owner', avatarUrl: null }, workspaces: [{ id: state.workspace.id, name: state.workspace.name, kind: 'personal' }], identity: { configured: true } };
  const mutations: { path: string; body: unknown }[] = [];
  const publish = async () => { snapshot.cursor++; await page.evaluate(value => window.dispatchEvent(new CustomEvent('memory-fixture', { detail: value })), snapshot); };
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const reply = (body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/v1/session') { const response = await route.fetch(); session.csrf = (await response.json()).csrf; await route.fulfill({ response, json: session }); return; }
    if (path.endsWith('/snapshot')) { await reply(snapshot); return; }
    if (path.endsWith('/manager/status')) { await reply(managerQueueStatus(state, new Date().toISOString())); return; }
    if (path.endsWith('/context')) { await reply({ versions: workflow.manager.versions.map(version => ({ ...version, ...contextMemory(version) })), proposals: [], deliveries: [{ runId: 'prior-run', taskId: 'prior-task', approvedContextVersion: 0, status: 'provider-acknowledged', boundary: 'initial-request', contextBrief: 'Pinned initial fixture context.', newerContextDelivery: 'unsupported' }] }); return; }
    if (path.endsWith('/context/memory')) {
      const body = route.request().postDataJSON();
      expect(route.request().headers()['x-csrf-token']).toBe(session.csrf);
      expect(route.request().headers()['idempotency-key']).toMatch(/^[a-f0-9-]{36}$/);
      mutations.push({ path, body }); applyMemoryAction(state, body, `browser-action-${mutations.length}`, new Date().toISOString());
      await reply({ snapshot }); await publish(); return;
    }
    if (route.request().method() !== 'GET') { mutations.push({ path, body: route.request().postDataJSON() }); await reply({ snapshot }); return; }
    await route.continue();
  });
  return { state, mutations, publish };
}

test('owner memory keeps immutable versions, evidence and initial delivery separate without inference', async ({ page }) => {
  const { state, mutations } = await fixture(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open manager', exact: true }).click();
  await expect(page.getByText('Reports are saved. Enable the manager with its reviewed account, model and limits to process them.', { exact: true })).toBeVisible();
  await page.getByText('Report evidence · failed', { exact: true }).filter({ visible: true }).click();
  await expect(page.getByText('npm test: unavailable · unavailable', { exact: true }).filter({ visible: true })).toBeVisible();
  await page.getByText('Context history and decisions', { exact: true }).click();
  const memory = page.locator('details').filter({ has: page.locator('summary', { hasText: /^Context history and decisions$/ }) });
  await expect(memory.getByText('Open blocker', { exact: true })).toBeVisible();
  await memory.getByLabel('Resolution evidence or reason', { exact: true }).fill('Owner reviewed the retained evidence.');
  await memory.getByRole('button', { name: 'Resolve blocker', exact: true }).click();
  await expect(memory.getByRole('combobox', { name: 'Context version', exact: true })).toHaveValue('2');
  await expect(memory.getByText('Resolved blocker', { exact: true })).toBeVisible();
  await expect(memory.getByLabel('Reason to reopen this blocker', { exact: true })).toHaveValue('');
  await memory.getByLabel('Decision or blocker text', { exact: true }).fill('Preserve the tested public interface.');
  await memory.getByRole('button', { name: 'Save accepted decision', exact: true }).click();
  await expect(memory.getByRole('combobox', { name: 'Context version', exact: true })).toHaveValue('3');
  await expect(memory.getByText('Preserve the tested public interface.', { exact: true })).toBeVisible();
  await memory.getByRole('combobox', { name: 'Context version', exact: true }).selectOption('1');
  await expect(memory.getByText('Open blocker', { exact: true })).toBeVisible();
  await expect(memory.getByRole('button', { name: 'Resolve blocker', exact: true })).toHaveCount(0);
  await expect(memory.getByText('Preserve the tested public interface.', { exact: true })).toHaveCount(0);
  await memory.getByRole('combobox', { name: 'Context version', exact: true }).selectOption('3');
  await memory.getByText('prior-run · initial v0 · provider-acknowledged', { exact: true }).click();
  await expect(memory.getByText('Pinned initial fixture context.', { exact: true })).toBeVisible();
  await expect(memory.getByText('Boundary: initial request. Newer context delivery: unsupported.', { exact: true })).toBeVisible();
  await memory.getByText('Manual handoff of v3', { exact: true }).click();
  const preview = memory.getByRole('textbox', { name: 'Review manual context', exact: true });
  await expect(preview).toHaveAttribute('readonly', '');
  expect(JSON.parse(await preview.inputValue())).toMatchObject({ version: 3, blockers: [{ status: 'resolved' }] });
  await memory.getByRole('combobox', { name: 'Handoff scope', exact: true }).selectOption('repo');
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { Object.assign(window, { copiedContextFixture: text }); } } }); });
  await memory.getByRole('button', { name: 'Copy reviewed context', exact: true }).click();
  await expect(memory.getByText('Copied for manual review and paste. Recipient delivery remains unverified.', { exact: true })).toBeVisible();
  const copied = await page.evaluate(() => (window as unknown as { copiedContextFixture: string }).copiedContextFixture);
  expect(JSON.parse(copied)).toMatchObject({ version: 3, scope: 'repo', acceptedDecisions: [{ text: 'Preserve the tested public interface.' }] });
  expect(mutations).toHaveLength(2); expect(mutations.every(item => item.path.endsWith('/context/memory'))).toBe(true);
  expect(state.workflow?.manager.jobs).toEqual([]); expect(state.workflow?.reservations).toEqual([]);
  await expect(page.getByRole('button', { name: 'Process saved reports · paid', exact: true })).toBeDisabled();
});

test('documented manager prices load only on request and never attest quality or enable spending', async ({ page }) => {
  const { state, mutations } = await fixture(page);
  const profile = getModelProfile('openai', 'gpt-5.4-mini-2026-03-17')!;
  state.workflow!.connections.push({ id: 'api-profile', provider: 'openai', mode: 'api', label: 'Fixture API', status: 'verified', verifiedAt: profile.documentedAt, createdAt: profile.documentedAt, accountIdentity: 'unavailable', models: [profile.model, 'unknown-model'], capabilities: { manager: true, managedExecution: true } });
  await page.goto('/'); await page.getByRole('button', { name: 'Open manager', exact: true }).click();
  await page.getByText('Manager account, model, and limits', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Manager billing connection', exact: true }).selectOption('api-profile');
  await page.getByRole('combobox', { name: 'Manager model', exact: true }).selectOption(profile.model);
  await expect(page.getByLabel('Input price (USD per million tokens)', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Load documented price fields', exact: true }).click();
  const price = profilePrice(profile);
  await expect(page.getByLabel('Input price (USD per million tokens)', { exact: true })).toHaveValue(String(price.inputPerMillionMicroUsd / 1000000));
  await expect(page.getByLabel('I checked this model against the quality needed for these summaries', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('Turn on the manager with this account and these limits', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('Also process saved reports automatically every 30 seconds — this spends money without another click', { exact: true })).not.toBeChecked();
  await page.getByRole('combobox', { name: 'Manager model', exact: true }).selectOption('unknown-model');
  await expect(page.getByText(/This model has no reviewed adapter profile/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load documented price fields', exact: true })).toHaveCount(0);
  expect(mutations).toEqual([]);
});

test('the first saved context becomes selectable while an existing history selection stays pinned', async ({ page }) => {
  const { state, publish } = await fixture(page);
  state.manager.version = 0; state.workflow!.manager.versions = [];
  await page.goto('/'); await page.getByRole('button', { name: 'Open manager', exact: true }).click();
  await page.getByText('Context history and decisions', { exact: true }).click();
  const memory = page.locator('details').filter({ has: page.locator('summary', { hasText: /^Context history and decisions$/ }) });
  await expect(memory.getByRole('combobox', { name: 'Context version', exact: true })).toHaveValue('0');
  applyMemoryAction(state, { action: 'accept-decision', expectedVersion: 0, text: 'First repository decision.', repoId: 'repo', sourceReportIds: [] }, 'first-real-version', new Date().toISOString());
  await publish();
  await expect(memory.getByRole('combobox', { name: 'Context version', exact: true })).toHaveValue('1');
  await expect(memory.getByText('Scope: Fixture repo', { exact: true })).toBeVisible();
  await expect(memory.getByRole('button', { name: 'Save accepted decision', exact: true })).toBeEnabled();
  applyMemoryAction(state, { action: 'accept-decision', expectedVersion: 1, text: 'Second workspace decision.', repoId: null, sourceReportIds: [] }, 'second-real-version', new Date().toISOString());
  await publish();
  await expect(memory.getByRole('combobox', { name: 'Context version', exact: true })).toHaveValue('1');
  await expect(memory.getByText('Second workspace decision.', { exact: true })).toHaveCount(0);
  await expect(memory.getByRole('button', { name: 'Save accepted decision', exact: true })).toHaveCount(0);
  await memory.getByRole('combobox', { name: 'Context version', exact: true }).selectOption('2');
  await expect(memory.getByText('Second workspace decision.', { exact: true })).toBeVisible();
  await expect(memory.getByText('Scope: Whole workspace', { exact: true })).toBeVisible();
});
