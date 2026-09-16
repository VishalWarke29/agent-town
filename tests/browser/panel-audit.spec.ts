import { expect, test, type Page } from '@playwright/test';
import type { BrowserSession, Snapshot } from '@agent-town/contracts';
import { getModelProfile, profilePrice } from '@agent-town/contracts';
import { initialWorkflow } from '../../apps/service/src/workflow/budget';
import { applyMemoryAction } from '../../apps/service/src/workflow/memory';
import { managerQueueStatus } from '../../apps/service/src/workflow/queue';

async function panelFixture(page: Page) {
  await page.addInitScript(() => {
    class FixtureEvents extends EventTarget {
      onopen: (() => void) | null = null;
      handler = (event: Event) => this.dispatchEvent(new MessageEvent('state', { data: JSON.stringify((event as CustomEvent).detail) }));
      constructor() { super(); window.addEventListener('panel-audit-fixture', this.handler); setTimeout(() => this.onopen?.(), 0); }
      close() { window.removeEventListener('panel-audit-fixture', this.handler); }
    }
    window.EventSource = FixtureEvents as unknown as typeof EventSource;
  });
  const at = '2026-09-15T12:00:00.000Z', workflow = initialWorkflow();
  const state: Snapshot['state'] = {
    schemaVersion: 1, workspace: { id: 'panel-audit', name: 'Panel audit fixture', mode: 'private' }, workflow,
    repositories: ['alpha', 'beta'].map((id, index) => ({ id, name: `${id} fixture`, description: '', branch: 'main', localPath: `C:\\panel-fixtures\\${id}`, color: '#aaa', language: 'TypeScript', position: [index * 7 - 4, -4] as [number, number] })),
    agents: [], runner: { schemaVersion: 1, tasks: [], runs: [], subscriptions: [], subscriptionDefault: null },
    activity: [], handoffs: [], simulation: { running: false, step: 0 }, manager: { version: 0, brief: 'Saved fixture context. No inference.', updatedAt: at },
  };
  const snapshot: Snapshot = { cursor: 1, state };
  const session: BrowserSession = { csrf: 'panel-fixture-csrf', mode: 'private', user: { id: 'panel-owner', login: 'fixture-owner', displayName: 'Fixture Owner', avatarUrl: null }, workspaces: [{ id: state.workspace.id, name: state.workspace.name, kind: 'personal' }], identity: { configured: true } };
  const mutations: { path: string; body: unknown }[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const control = { failReconciliation: false };
  const publish = async () => { snapshot.cursor++; await page.evaluate(value => window.dispatchEvent(new CustomEvent('panel-audit-fixture', { detail: value })), snapshot); };
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const reply = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/v1/session') { await reply(session); return; }
    if (path.endsWith('/snapshot')) { await reply(snapshot); return; }
    if (path === '/api/v1/workspaces/panel-audit/observation/native-setup' && route.request().method() === 'GET') { await reply({ sources: [], tools: [] }); return; }
    if (path.endsWith('/manager/status')) { await reply(managerQueueStatus(state, at)); return; }
    if (path.endsWith('/context')) { await reply({ versions: workflow.manager.versions, deliveries: [] }); return; }
    if (path.endsWith('/services') && route.request().method() === 'GET') { await reply({ sources: [], traffic: [], inventories: [], coverage: [] }); return; }
    if (route.request().method() !== 'GET') {
      mutations.push({ path, body: route.request().postDataJSON() });
      if (path.endsWith('/reconcile')) {
        if (control.failReconciliation) { await reply({ error: 'fixture_reconciliation_failed', message: 'Provider record is not available. Retry this request.' }, 409); return; }
        const id = path.split('/').at(-2)!;
        const reservation = workflow.reservations.find(item => item.id === id)!;
        reservation.status = 'settled'; reservation.actualMicroUsd = 100;
        await reply({ snapshot }); await publish(); return;
      }
      await reply({ error: 'unexpected_fixture_mutation', message: 'This audit action is not permitted by the fixture.' }, 400); return;
    }
    await reply({});
  });
  return { state, workflow, mutations, errors, control, publish };
}

test('usage reconciliation never carries verified counts into another request', async ({ page }) => {
  const fixture = await panelFixture(page);
  const price = profilePrice(getModelProfile('openai', 'gpt-5.4-mini-2026-03-17')!);
  fixture.workflow.reservations = ['request-a', 'request-b'].map(id => ({
    id, runId: id, purpose: 'worker', connectionId: 'fixture-api', provider: 'openai', mode: 'api', model: price,
    amountMicroUsd: 1000, runBudgetMicroUsd: 1000, actualMicroUsd: null, usage: null, status: 'uncertain',
    day: '2026-09-15', createdAt: '2026-09-15T12:00:00.000Z', settledAt: null, settlementSource: null,
  }));
  await page.goto('/'); await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('button', { name: 'Usage', exact: true }).click();
  await page.getByText('Reconcile an uncertain request', { exact: true }).click();
  const selector = page.getByRole('combobox', { name: 'Uncertain request', exact: true });
  const labels = ['Verified input tokens', 'Verified output tokens', 'Verified cached input tokens', 'Verified cache-write tokens'];
  const fillCounts = async () => { for (const [index, label] of labels.entries()) await page.getByLabel(label, { exact: true }).fill(['125', '20', '5', '0'][index]!); };
  const emptyCounts = async () => { for (const label of labels) await expect(page.getByLabel(label, { exact: true })).toHaveValue(''); };
  await expect(selector).toHaveValue('request-a'); await fillCounts();
  await selector.selectOption('request-b'); await emptyCounts();
  await fillCounts(); fixture.control.failReconciliation = true;
  await page.getByRole('button', { name: 'Save verified usage', exact: true }).click();
  await expect(page.getByText('Provider record is not available. Retry this request.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Verified input tokens', { exact: true })).toHaveValue('125');
  await selector.selectOption('request-a'); await emptyCounts();
  await expect(page.getByText('Provider record is not available. Retry this request.', { exact: true })).toHaveCount(0);
  await fillCounts(); fixture.control.failReconciliation = false;
  await page.getByRole('button', { name: 'Save verified usage', exact: true }).click();
  await expect(selector).toHaveValue(''); await emptyCounts();
  await expect(page.getByRole('button', { name: 'Save verified usage', exact: true })).toBeDisabled();
  await selector.selectOption('request-b'); await emptyCounts();
  expect(fixture.mutations.map(item => item.path)).toEqual(['/api/v1/workspaces/panel-audit/usage/request-b/reconcile', '/api/v1/workspaces/panel-audit/usage/request-a/reconcile']);
  expect(fixture.errors).toEqual([]);
});

test('telemetry drafts require explicit repo selection after the selected project is removed', async ({ page }) => {
  const fixture = await panelFixture(page);
  await page.goto('/'); await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('button', { name: 'API activity', exact: true }).click();
  await page.getByText('Discover source API definitions', { exact: true }).click();
  await page.getByText('Connect measured service activity', { exact: true }).click();
  const repo = page.getByRole('combobox', { name: 'API repository', exact: true });
  const paths = page.getByLabel('OpenAPI files (optional, one relative path per line)', { exact: true });
  const service = page.getByRole('textbox', { name: 'Running service name', exact: true });
  await expect(repo).toHaveValue('alpha'); await paths.fill('alpha-api.json'); await service.fill('alpha-local');
  fixture.state.repositories = fixture.state.repositories.filter(value => value.id !== 'alpha'); await fixture.publish();
  await expect(repo).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Scan API definitions', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Prepare service connection', exact: true })).toBeDisabled();
  await expect(page.getByText(/A removed repository is never replaced automatically/)).toBeVisible();
  await repo.selectOption('beta'); await expect(paths).toHaveValue(''); await expect(service).toHaveValue('');
  expect(fixture.mutations).toEqual([]); expect(fixture.errors).toEqual([]);
});

test('removed memory scope stays explicit and cannot silently become workspace memory', async ({ page }) => {
  const fixture = await panelFixture(page);
  applyMemoryAction(fixture.state, { action: 'accept-decision', expectedVersion: 0, text: 'Keep the alpha public interface.', repoId: 'alpha', sourceReportIds: [] }, 'alpha-decision', '2026-09-15T12:00:00.000Z');
  await page.goto('/'); await page.getByRole('button', { name: 'Open manager', exact: true }).click();
  await page.getByText('Context history and decisions', { exact: true }).click();
  const scope = page.getByRole('combobox', { name: 'Memory scope', exact: true });
  await scope.selectOption('alpha'); await page.getByLabel('Decision or blocker text', { exact: true }).fill('Another alpha-only decision.');
  await page.getByText('Manual handoff of v1', { exact: true }).click();
  const handoff = page.getByRole('combobox', { name: 'Handoff scope', exact: true }); await handoff.selectOption('alpha');
  fixture.state.repositories = fixture.state.repositories.filter(value => value.id !== 'alpha'); await fixture.publish();
  await expect(scope).toHaveValue('alpha');
  await expect(scope.locator('option:checked')).toHaveText('Repository alpha · no longer connected');
  await expect(page.getByRole('button', { name: 'Save accepted decision', exact: true })).toBeDisabled();
  await expect(handoff).toHaveValue('alpha');
  await expect(handoff.locator('option:checked')).toHaveText('Repository alpha · saved scope, no longer connected');
  const preview = JSON.parse(await page.getByRole('textbox', { name: 'Review manual context', exact: true }).inputValue());
  expect(preview.scope).toBe('alpha'); expect(preview.acceptedDecisions[0].text).toBe('Keep the alpha public interface.');
  await scope.selectOption(''); await expect(page.getByRole('button', { name: 'Save accepted decision', exact: true })).toBeEnabled();
  expect(fixture.mutations).toEqual([]); expect(fixture.errors).toEqual([]);
});
