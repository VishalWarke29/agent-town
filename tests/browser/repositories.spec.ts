import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { Agent, AgentHistoryDetail, BrowserSession, GitHubListingStatus, Handoff, Repository, Snapshot } from '@agent-town/contracts';

const workspaceId = 'fixture-repository-journey';
const checkedAt = '2026-09-14T12:00:00Z';
const repo: Repository = { id: 'local-fixture', name: 'Fixture checkout', source: 'local', description: 'Fixture metadata', branch: 'main', color: '#859b87', position: [-6, -3], language: 'Unavailable', localPath: String.raw`C:\fixture-projects\checkout`, scan: { at: checkedAt, coverage: 'complete', reasons: [] }, git: { availability: 'available', head: 'a'.repeat(40), changedFiles: 0, untrackedFiles: null }, discoveryStatus: { state: 'current', checkedAt, lastVerifiedAt: checkedAt, reasons: [] } };

async function fixture(page: Page, mutate: (path: string, body: unknown, state: Snapshot) => unknown) {
  const snapshot: Snapshot = { cursor: 1, state: { schemaVersion: 1, workspace: { id: workspaceId, name: 'Repository setup', mode: 'private' }, simulation: { running: false, step: 0 }, repositories: [], agents: [], handoffs: [], activity: [], manager: { version: 0, brief: 'No reports received.', updatedAt: null }, discovery: { roots: [], candidates: [], operation: null } } };
  const session: BrowserSession = { csrf: 'fixture-csrf', mode: 'private', applicationMode: 'development', user: { id: 'fixture-owner', login: 'fixture-owner', displayName: 'Fixture Owner', avatarUrl: null }, workspaces: [{ id: workspaceId, name: 'Repository setup', kind: 'personal' }], identity: { configured: true } };
  await page.addInitScript(() => {
    class FixtureEvents extends EventTarget {
      onopen: (() => void) | null = null;
      listener = (event: Event) => this.dispatchEvent(new MessageEvent('state', { data: JSON.stringify((event as CustomEvent).detail) }));
      constructor() { super(); window.addEventListener('fixture-repositories', this.listener); setTimeout(() => this.onopen?.(), 0); }
      close() { window.removeEventListener('fixture-repositories', this.listener); }
    }
    window.EventSource = FixtureEvents as unknown as typeof EventSource;
  });
  const publish = async () => { snapshot.cursor++; await page.evaluate(value => window.dispatchEvent(new CustomEvent('fixture-repositories', { detail: value })), snapshot); };
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const reply = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/api/v1/session') return reply(session);
    if (path.endsWith('/snapshot')) return reply(snapshot);
    if (path.startsWith(`/api/v1/workspaces/${workspaceId}/`)) {
      const result = mutate(path, route.request().postDataJSON(), snapshot);
      if (result instanceof Error) return reply({ code: 'FIXTURE_ERROR', message: result.message }, 400);
      await reply(result); await publish(); return;
    }
    return reply({ error: { code: 'UNEXPECTED_FIXTURE_REQUEST', message: 'No real requests in repository fixtures.' } }, 400);
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Connect repositories', exact: true }).click();
  return { snapshot, publish };
}

test('folder setup explains disabled actions and preserves stale evidence through cancellation', async ({ page }, testInfo) => {
  const calls: string[] = [];
  const { snapshot, publish } = await fixture(page, (path, body, current) => {
    calls.push(path);
    if (path.endsWith('/roots')) {
      const selected = (body as { path: string }).path;
      if (selected.endsWith('missing')) return new Error('The selected folder is unavailable or is not a directory.');
      current.state.discovery!.roots = [selected]; return { ok: true };
    }
    if (path.endsWith('/scans')) { current.state.discovery!.operation = { id: 'scan-fixture', status: 'running', startedAt: checkedAt, finishedAt: null, message: 'Reading selected folder metadata…', coverage: null }; return { operationId: 'scan-fixture' }; }
    if (path.endsWith('/cancel')) {
      current.state.discovery!.operation = { id: 'scan-fixture', status: 'cancelled', startedAt: checkedAt, finishedAt: checkedAt, message: 'Scan cancelled. Previous inventory is preserved as stale; scan again to verify it.', coverage: 'partial', reasons: ['cancelled'] };
      current.state.repositories[0]!.discoveryStatus = { state: 'stale', checkedAt, lastVerifiedAt: '2026-09-14T10:00:00Z', reasons: ['cancelled'] };
      return { cancellationRequested: true };
    }
    if (path.endsWith('/roots/remove/preview')) return { path: (body as { path: string }).path, repositories: [{ id: repo.id, name: repo.name }], allowed: true, reasons: [], reviewToken: 'b'.repeat(64) };
    if (path.endsWith('/roots/remove')) {
      expect(body).toEqual({ path: String.raw`C:\fixture-projects`, reviewToken: 'b'.repeat(64) });
      current.state.discovery!.roots = []; current.state.discovery!.candidates = []; current.state.discovery!.operation = null; current.state.repositories = []; return { ok: true };
    }
    return { ok: true };
  });
  const local = page.getByRole('region', { name: 'Local folders', exact: true });
  await expect(local.getByLabel('Selected parent folder', { exact: true })).toBeEmpty();
  await expect(local.getByLabel('Selected parent folder', { exact: true })).not.toHaveAttribute('placeholder');
  await expect(local.getByText('No folders are allowed yet.', { exact: true })).toBeVisible();
  await expect(local.getByRole('button', { name: 'Add selected folder', exact: true })).toBeDisabled();
  await expect(local.getByRole('button', { name: 'Scan selected folders', exact: true })).toBeDisabled();
  await expect(local.getByText('Add a parent folder above before scanning.', { exact: true })).toBeVisible();
  await page.getByLabel('Selected parent folder', { exact: true }).fill(String.raw`C:\fixture-projects\missing`);
  await local.getByRole('button', { name: 'Add selected folder', exact: true }).click();
  await expect(local.getByRole('alert')).toContainText('unavailable or is not a directory');
  await page.getByLabel('Selected parent folder', { exact: true }).fill(String.raw`C:\fixture-projects`);
  await local.getByRole('button', { name: 'Add selected folder', exact: true }).click();
  await expect(local.getByRole('heading', { name: 'Folders allowed for discovery · 1/8' })).toBeVisible();
  snapshot.state.repositories = [structuredClone(repo)]; snapshot.state.discovery!.candidates = [];
  await publish();
  await local.getByRole('button', { name: 'Scan selected folders', exact: true }).click();
  await local.getByRole('button', { name: 'Cancel scan', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: /Fixture checkout/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Fixture checkout/ })).toBeEnabled();
  await expect(page.getByText(/stale · Last check/)).toBeVisible();
  expect(calls.some(path => path.endsWith('/github/repositories'))).toBe(false);
  expect((await new AxeBuilder({ page }).include('.repository-setup').analyze()).violations).toEqual([]);
  await local.getByRole('button', { name: String.raw`Review removal of C:\fixture-projects`, exact: true }).click();
  await expect(local.getByRole('region', { name: 'Folder removal review' })).toContainText('disconnect 1 selected repositories');
  expect(calls.some(path => path.endsWith('/roots/remove'))).toBe(false);
  await local.getByRole('button', { name: 'Remove allowed folder', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `docs/assets/previews/repository-removal-${testInfo.project.name}.png` });
  await local.getByRole('button', { name: 'Keep folder', exact: true }).click();
  await expect(local.getByRole('region', { name: 'Folder removal review' })).toHaveCount(0);
  await local.getByRole('button', { name: String.raw`Review removal of C:\fixture-projects`, exact: true }).click();
  await local.getByRole('button', { name: 'Remove allowed folder', exact: true }).click();
  await expect(local.getByText('No folders are allowed yet.', { exact: true })).toBeVisible();
  await expect(local.getByRole('button', { name: 'Scan selected folders', exact: true })).toBeDisabled();
});

test('ended sessions archive through an explicit review and remain readable in history', async ({ page }, testInfo) => {
  const agent: Agent = { id: 'observed-one', name: 'Fixture observer', provider: 'Codex', role: 'Observed session', repoId: repo.id, task: 'External fixture session', activity: 'offline', color: '#859b87', home: [-5, -1], updatedAt: checkedAt, files: [], evidence: 'Reported activity', contextVersion: null, observation: { connectionId: 'fixture-connection', sessionId: 'fixture-session', parentSessionId: null, lastSequence: 3, sourceTime: checkedAt, freshness: 'current', billing: 'unavailable' } };
  const report: Handoff = { id: 'fixture-report', agentId: agent.id, repoId: repo.id, summary: 'Saved report remains available after the character leaves the town.', createdAt: checkedAt, status: 'saved', contextVersion: null, delivery: 'unsupported' };
  const detail: AgentHistoryDetail = { agent, repository: repo, archivedAt: checkedAt, reports: [report], reportCount: 1, reportsNextOffset: null, runs: [], tasks: [] };
  let archived = false;
  const { snapshot, publish } = await fixture(page, (path, body, current) => {
    if (path.endsWith(`/agents/${agent.id}/archive`)) {
      if (body && typeof body === 'object' && 'reviewToken' in body) { expect(body).toEqual({ reviewToken: 'a'.repeat(64) }); archived = true; current.state.agents = []; current.state.history = { archivedAgents: 1, updatedAt: checkedAt }; return { ok: true }; }
      return { agentId: agent.id, name: agent.name, repositoryName: repo.name, allowed: true, reasons: [], reportCount: 1, reviewToken: 'a'.repeat(64) };
    }
    if (path.endsWith(`/history/agents/${agent.id}`)) return detail;
    if (path.endsWith('/history/agents')) return { items: archived ? [{ id: agent.id, name: agent.name, provider: agent.provider, repoId: repo.id, repositoryName: repo.name, activity: agent.activity, updatedAt: checkedAt, archivedAt: checkedAt }] : [], total: archived ? 1 : 0, nextOffset: null };
    return new Error('Unexpected history fixture request');
  });
  snapshot.state.repositories = [repo]; snapshot.state.agents = [agent]; snapshot.state.handoffs = [report]; await publish();
  await page.getByRole('button', { name: 'Close navigation', exact: true }).click();
  await page.getByRole('button', { name: 'Open agents', exact: true }).click();
  await page.getByText('Session history and archiving', { exact: true }).click();
  await page.getByRole('button', { name: 'Review archive for Fixture observer', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Archive review for Fixture observer' })).toContainText('1 saved reports stay available');
  expect(archived).toBe(false);
  await page.getByRole('button', { name: 'Archive session', exact: true }).click();
  await expect(page.getByRole('button', { name: 'In town (0)', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'History (1)', exact: true }).click();
  await page.getByRole('button', { name: 'Open history for Fixture observer', exact: true }).click();
  await expect(page.getByText(report.summary, { exact: true })).toBeVisible();
  await expect(page.getByText('fixture-session', { exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).include('.session-history').analyze()).violations).toEqual([]);
  await page.getByText(report.summary, { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `docs/assets/previews/session-history-${testInfo.project.name}.png` });
});

test('GitHub access diagnostics remain separate from local scope and explain empty and partial listings', async ({ page }, testInfo) => {
  let checks = 0;
  await fixture(page, (path, _body, snapshot) => {
    expect(path.endsWith('/github/repositories')).toBe(true); checks++;
    const diagnostics: GitHubListingStatus = checks === 1 ? { checkedAt, status: 'complete', installationCount: 0, installationTotal: 0, repositoryTotal: 0, receivedCount: 0, retainedCount: 0, selectableCount: 0, reasons: ['no-installations'] }
      : { checkedAt, status: 'partial', installationCount: 1, installationTotal: 1, repositoryTotal: 250, receivedCount: 2, retainedCount: 2, selectableCount: 2, reasons: ['deadline'] };
    const repositories = checks === 1 ? [] : [1, 2].map(index => ({ ...repo, id: `github-${index}`, name: `fixture/remote-${index}`, source: 'github' as const, git: undefined, localPath: undefined }));
    snapshot.state.discovery!.githubListing = diagnostics; snapshot.state.discovery!.candidates = repositories;
    return { repositories, partial: checks !== 1, diagnostics };
  });
  const github = page.getByRole('region', { name: 'GitHub repositories', exact: true });
  await expect(github.getByRole('button', { name: 'List permitted GitHub repos', exact: true })).toBeEnabled();
  await github.getByRole('button', { name: 'List permitted GitHub repos', exact: true }).click();
  await expect(github.getByText(/No installation is available to this account/)).toBeVisible();
  await expect(github.getByText(/0 received · 0 retained/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Local folders', exact: true }).getByText('No folders are allowed yet.', { exact: true })).toBeVisible();
  await github.getByRole('button', { name: 'List permitted GitHub repos', exact: true }).click();
  await expect(github.getByText(/shared 12-second limit/)).toBeVisible();
  await expect(github.getByText(/2 received · 2 retained from this check · 2 currently available/)).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /fixture\/remote-1/ })).toBeEnabled();
  expect((await new AxeBuilder({ page }).include('.repository-setup').analyze()).violations).toEqual([]);
  await github.getByText(/2 received · 2 retained from this check · 2 currently available/).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `docs/assets/previews/repository-github-${testInfo.project.name}.png` });
});
