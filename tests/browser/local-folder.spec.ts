import AxeBuilder from '@axe-core/playwright';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Snapshot } from '@agent-town/contracts';
import { createApp } from '../../apps/service/src/app';
import { IdentityRegistry, IdentityService, type CredentialVault, type IdentityProvider } from '../../apps/service/src/identity';

test('a plain allowed folder becomes a persistent local project without initializing Git', async ({ page }, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-town-local-folder-'));
  const projectName = 'Plain project café';
  const projectPath = join(directory, projectName);
  const sourcePath = join(projectPath, 'notes.txt');
  const originalSource = 'A plain project fixture. Registration must leave this file unchanged.\n';
  mkdirSync(projectPath);
  writeFileSync(sourcePath, originalSource);
  let now = Date.now(), modelCalls = 0, githubListings = 0;
  const errors: string[] = [], remote: string[] = [];
  const mutations: { path: string; body: unknown }[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const vaultData = new Map<string, string>();
  const vault: CredentialVault = {
    available: true,
    put: async (key, value) => { vaultData.set(key, value); },
    get: async key => vaultData.get(key) ?? null,
    delete: async key => { vaultData.delete(key); },
  };
  const provider: IdentityProvider = {
    begin: async () => ({ deviceCode: 'fixture-device', userCode: 'TEST-CODE', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 }),
    poll: async () => ({ status: 'authorized', accessToken: 'fixture-test-credential', expiresIn: 3600 }),
    verifyUser: async () => ({ id: '602', login: 'folder-fixture-owner', displayName: 'Folder Fixture Owner', avatarUrl: null }),
    listRepositories: async () => { githubListings++; return { repositories: [], truncated: false, checkedAt: new Date(now).toISOString() }; },
  };
  const identity = new IdentityService({ registry: new IdentityRegistry(join(directory, 'identity.sqlite')), vault, provider, clientId: 'Iv1.localFolderFixture', now: () => now });
  const forbiddenModelCall = async (): Promise<never> => { modelCalls++; throw new Error('Local folder setup must not call a model'); };
  const instance = await createApp({ port: 4311, database: ':memory:', privateDirectory: join(directory, 'private'), identity, vault, workflowProvider: { verify: forbiddenModelCall, countInput: forbiddenModelCall, summarize: forbiddenModelCall } });
  const baseHeaders = { host: '127.0.0.1:4311', origin: 'http://127.0.0.1:4311' };
  try {
    // Only account authorization and browser event delivery are fixtures. Folder
    // validation, disk scanning, registration, selection and persistence use the service.
    const initial = await instance.app.inject({ method: 'POST', url: '/api/v1/session', headers: baseHeaders });
    let cookie = initial.cookies.map(item => `${item.name}=${item.value}`).join('; ');
    const start = await instance.app.inject({ method: 'POST', url: '/api/v1/auth/github/device/start', headers: { ...baseHeaders, cookie, 'x-csrf-token': initial.json().csrf } });
    expect(start.statusCode).toBe(200); now += 6000;
    const poll = await instance.app.inject({ method: 'POST', url: '/api/v1/auth/github/device/poll', payload: { flowId: start.json().flowId }, headers: { ...baseHeaders, cookie, 'x-csrf-token': initial.json().csrf } });
    expect(poll.statusCode).toBe(200);
    cookie = poll.cookies.map(item => `${item.name}=${item.value}`).join('; ');
    const created = await instance.app.inject({ method: 'POST', url: '/api/v1/workspaces', payload: { name: 'Plain folder workspace', kind: 'personal' }, headers: { ...baseHeaders, cookie, 'x-csrf-token': poll.json().session.csrf } });
    expect(created.statusCode).toBe(200);
    const workspaceId: string = created.json().workspace.id;
    const prefix = `/api/v1/workspaces/${workspaceId}`;
    const snapshot = async (): Promise<Snapshot> => {
      const response = await instance.app.inject({ url: `${prefix}/snapshot`, headers: { ...baseHeaders, cookie } });
      expect(response.statusCode).toBe(200);
      return response.json();
    };
    await page.exposeFunction('readLocalFolderFixtureSnapshot', snapshot);
    await page.addInitScript(() => {
      const readSnapshot = (window as unknown as { readLocalFolderFixtureSnapshot(): Promise<{ cursor: number; state: { workspace: { id: string } } }> }).readLocalFolderFixtureSnapshot;
      class FixtureEvents extends EventTarget {
        onopen: (() => void) | null = null;
        closed = false;
        cursor = -1;
        timer?: ReturnType<typeof setTimeout>;
        constructor(readonly url: string) {
          super();
          this.timer = setTimeout(() => { if (!this.closed) { this.onopen?.(); void this.read(); } }, 0);
        }
        async read() {
          try {
            const saved = await readSnapshot();
            if (!this.closed && this.url.includes(`/workspaces/${saved.state.workspace.id}/`) && saved.cursor !== this.cursor) {
              this.cursor = saved.cursor;
              this.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(saved) }));
            }
          } finally { if (!this.closed) this.timer = setTimeout(() => void this.read(), 75); }
        }
        close() { this.closed = true; clearTimeout(this.timer); }
      }
      window.EventSource = FixtureEvents as unknown as typeof EventSource;
    });
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== baseHeaders.origin) { remote.push(url.origin); await route.abort(); return; }
      if (!url.pathname.startsWith('/api/v1/')) { await route.continue(); return; }
      if (request.method() !== 'GET' && url.pathname !== '/api/v1/session') mutations.push({ path: url.pathname, body: request.postDataJSON() });
      const response = await instance.app.inject({ method: request.method() as 'GET' | 'POST' | 'PATCH', url: `${url.pathname}${url.search}`, headers: { ...request.headers(), ...baseHeaders, cookie }, ...(request.postData() ? { payload: request.postData()! } : {}) });
      await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
    });
    await page.goto('/');
    await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Connect repositories', exact: true }).click();
    const local = page.getByRole('region', { name: 'Local folders', exact: true });
    await local.getByLabel('Selected parent folder', { exact: true }).fill(projectPath);
    await local.getByRole('button', { name: 'Add selected folder', exact: true }).click();
    await expect(local.getByRole('button', { name: `Use ${projectPath} as a local project`, exact: true })).toBeEnabled();
    await local.getByRole('button', { name: 'Scan selected folders', exact: true }).click();
    await expect(local.getByRole('heading', { name: 'No Git repositories found', exact: true })).toBeVisible();
    await expect(local.getByText(/Your folder may still be a project/)).toBeVisible();
    const empty = await snapshot();
    expect(empty.state.discovery?.operation).toMatchObject({ status: 'complete', foundCount: 0 });
    expect(empty.state.repositories).toEqual([]);
    expect(empty.state.agents).toEqual([]);
    const useProject = local.getByRole('button', { name: `Use ${projectPath} as a local project`, exact: true });
    await useProject.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `docs/assets/previews/local-folder-setup-${testInfo.project.name}.png` });
    await useProject.focus();
    await expect(useProject).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(local.getByRole('button', { name: `Project connected: ${projectPath}`, exact: true })).toBeDisabled();
    const candidate = page.locator('.candidate-row').filter({ hasText: projectName });
    await expect(candidate.getByRole('checkbox')).toBeChecked();
    await expect(candidate).toContainText('Local folder · Git not configured');
    const saved = await snapshot();
    expect(saved.state.repositories).toHaveLength(1);
    const repository = saved.state.repositories[0]!;
    expect(repository).toMatchObject({ name: projectName, source: 'local', localPath: projectPath, git: { availability: 'unavailable', head: null, changedFiles: null, untrackedFiles: null } });
    expect(saved.state.agents).toEqual([]);
    expect((await new AxeBuilder({ page }).include('.repository-setup').analyze()).violations).toEqual([]);

    await page.reload();
    await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await page.getByRole('button', { name: 'Repositories', exact: true }).click();
    await expect(candidate.getByRole('checkbox')).toBeChecked();
    await local.getByRole('button', { name: 'Scan selected folders', exact: true }).click();
    await expect.poll(async () => (await snapshot()).state.discovery?.operation?.id).not.toBe(empty.state.discovery?.operation?.id);
    await expect.poll(async () => (await snapshot()).state.discovery?.operation?.status).toBe('complete');
    const rescanned = await snapshot();
    expect(rescanned.state.repositories.map(repo => repo.id)).toEqual([repository.id]);
    expect(rescanned.state.repositories[0]?.localPath).toBe(projectPath);
    await expect(candidate.getByRole('checkbox')).toBeChecked();
    await page.getByRole('button', { name: 'Close navigation', exact: true }).click();
    const house = page.locator('button.world-label[data-repo-id]').filter({ hasText: projectName });
    await expect(house).toHaveAttribute('data-repo-id', repository.id);
    await house.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('room-context')).toHaveAttribute('data-repo-id', repository.id);
    await page.getByRole('button', { name: 'Repository details', exact: true }).click();
    const details = page.getByTestId('right-drawer');
    await expect(details).toContainText('Local project folder');
    await expect(details).toContainText('Not configured · observation available');
    await expect(details.getByTestId('repository-agents')).toHaveAttribute('data-repo-id', repository.id);
    await expect(details.getByRole('heading', { name: 'No observed sessions for this repository', exact: true })).toBeVisible();
    expect((await new AxeBuilder({ page }).include('[data-testid="right-drawer"]').analyze()).violations).toEqual([]);
    await page.screenshot({ path: `docs/assets/previews/local-folder-${testInfo.project.name}.png` });
    expect(mutations.filter(call => call.path.endsWith('/projects/local'))).toEqual([{ path: `${prefix}/projects/local`, body: { path: projectPath } }]);
    expect(mutations.every(call => ['/roots', '/scans', '/projects/local'].some(suffix => call.path.endsWith(suffix)))).toBe(true);
    expect(readFileSync(sourcePath, 'utf8')).toBe(originalSource);
    expect(existsSync(join(projectPath, '.git'))).toBe(false);
    expect(modelCalls).toBe(0); expect(githubListings).toBe(0);
    expect(remote).toEqual([]); expect(errors).toEqual([]);
  } finally {
    try {
      if (!page.isClosed()) await page.close();
    } finally {
      await instance.app.close();
      const full = resolve(directory);
      if (!full.startsWith(resolve(tmpdir()) + sep) || !full.includes('agent-town-local-folder-')) throw new Error('Unsafe fixture cleanup');
      rmSync(full, { recursive: true, force: true });
    }
  }
});
