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
  // Connecting a project reads no tool profile folder (D38, H0-02; tests/browser/houses-first.spec.ts pins it). They are still pointed at nothing,
  // so that if a tool check ever came back it could not depend on the machine running this journey.
  const profileEnv = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CURSOR_CONFIG_DIR', 'COPILOT_HOME'] as const;
  const savedEnv = Object.fromEntries(profileEnv.map(name => [name, process.env[name]]));
  for (const name of profileEnv) process.env[name] = join(directory, 'absent-profile');
  const errors: string[] = [], remote: string[] = [];
  const mutations: { path: string; body: unknown }[] = [];
  // Every /api/v1 request, reads included (mutations above are only the writes), so "nothing was checked" can be asserted.
  const requests: string[] = [];
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
      requests.push(`${request.method()} ${url.pathname}${url.search}`);
      if (request.method() !== 'GET' && url.pathname !== '/api/v1/session') mutations.push({ path: url.pathname, body: request.postDataJSON() });
      const response = await instance.app.inject({ method: request.method() as 'GET' | 'POST' | 'PATCH', url: `${url.pathname}${url.search}`, headers: { ...request.headers(), ...baseHeaders, cookie }, ...(request.postData() ? { payload: request.postData()! } : {}) });
      await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
    });
    await page.goto('/');
    await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Connect a project', exact: true }).click();
    const local = page.getByRole('region', { name: 'Local folders', exact: true });
    await local.getByLabel('Project folder', { exact: true }).fill(projectPath);
    await local.getByRole('button', { name: 'Add this project', exact: true }).click();
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
    // The first connected project opens its own details. D38 (H0-02): live tracking is there but collapsed, and nothing has been checked:
    // no tool check, no session read and no health poll (there is no connection). It used to open itself and scan this computer's tool folders.
    // H0-07: the Watch sessions (optional) panel now renders last in the inspector, after facts, the Assign line, residents and details.
    const firstDetails = page.getByTestId('right-drawer');
    await expect(firstDetails).toContainText('Local project folder');
    const tracking = firstDetails.getByRole('region', { name: /^Live tracking:/ });
    await expect(tracking).toBeVisible();
    await expect(tracking.getByRole('button', { name: 'Show details', exact: true })).toHaveAttribute('aria-expanded', 'false');
    await page.waitForTimeout(1500);
    expect(requests.filter(request => /\/observation(\/|\?|$)|\/health/.test(request)), `connecting must check nothing.\n${requests.join('\n')}`).toEqual([]);
    await page.getByRole('button', { name: 'Close details', exact: true }).click();
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await page.getByRole('button', { name: 'Repositories', exact: true }).click();
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
    // H0-07: a plain folder's Git fact reads "Plain folder · no Git" (DES-02 IN-2), never the old
    // "Not configured · observation available" wording.
    await expect(details).toContainText('Plain folder · no Git');
    await expect(details.getByTestId('repository-agents')).toHaveAttribute('data-repo-id', repository.id);
    await expect(details.getByRole('heading', { name: 'No sessions are being watched. No sessions were scanned.', exact: true })).toBeVisible();
    // H0-07: facts, the Assign slot, Residents, Details, then Watch sessions (optional) last — on real,
    // service-backed data, not just a fixture.
    expect(await details.locator('[data-slot]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-slot')))).toEqual(['facts', 'assign', 'residents', 'details', 'watch']);
    expect((await new AxeBuilder({ page }).include('[data-testid="right-drawer"]').analyze()).violations).toEqual([]);
    await page.screenshot({ path: `docs/assets/previews/local-folder-${testInfo.project.name}.png` });
    expect(mutations.filter(call => call.path.endsWith('/projects/local'))).toEqual([{ path: `${prefix}/projects/local`, body: { path: projectPath } }]);
    expect(mutations.every(call => ['/roots', '/scans', '/projects/local'].some(suffix => call.path.endsWith(suffix)))).toBe(true);
    // The whole journey (connect, reload, enter the house, open its details) made no tool check, session read, connection call or health poll.
    expect(requests.filter(request => /\/observation(\/|\?|$)|\/health/.test(request)), `the journey must check nothing.\n${requests.join('\n')}`).toEqual([]);
    expect(readFileSync(sourcePath, 'utf8')).toBe(originalSource);
    expect(existsSync(join(projectPath, '.git'))).toBe(false);
    expect(modelCalls).toBe(0); expect(githubListings).toBe(0);
    expect(remote).toEqual([]); expect(errors).toEqual([]);
  } finally {
    try {
      if (!page.isClosed()) await page.close();
    } finally {
      for (const name of profileEnv) { if (savedEnv[name] === undefined) delete process.env[name]; else process.env[name] = savedEnv[name]; }
      await instance.app.close();
      const full = resolve(directory);
      if (!full.startsWith(resolve(tmpdir()) + sep) || !full.includes('agent-town-local-folder-')) throw new Error('Unsafe fixture cleanup');
      rmSync(full, { recursive: true, force: true });
    }
  }
});
