import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Snapshot } from '@agent-town/contracts';
import { createApp } from '../../apps/service/src/app';
import { IdentityRegistry, IdentityService, type CredentialVault, type IdentityProvider } from '../../apps/service/src/identity';
import { isolatedProfile } from '../helpers/isolated-profile';

/**
 * Project Vault (DR-061, 2026-09-25): a real click-through of scan → secret-gate → backup →
 * list → restore against the REAL service (createApp, an in-process Fastify instance, no mocked
 * API responses) and a REAL local project folder and vault destination on disk — the same
 * real-service rig houses-first.spec.ts uses (a fake GitHub device-flow IdentityProvider stands in
 * for a real sign-in, since no real GitHub credential exists in this test environment; every other
 * layer, including the actual encryption and file I/O, is the genuine code path).
 */
async function realTown(page: Page) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-town-vault-e2e-'));
  const projectPath = join(directory, 'Vault fixture project');
  const vaultDirectory = join(directory, 'vault-store');
  const restoreDirectory = join(directory, 'restore-target');
  mkdirSync(projectPath);
  mkdirSync(vaultDirectory);
  writeFileSync(join(projectPath, 'app.js'), 'console.log("hello from the vault fixture");\n');
  writeFileSync(join(projectPath, '.gitignore'), '.env\n');
  writeFileSync(join(projectPath, '.env'), 'AWS_KEY=AKIAABCDEFGHIJKLMNOP\n');
  const profile = isolatedProfile();
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const secrets = new Map<string, string>();
  const vault: CredentialVault = { available: true, put: async (key, value) => { secrets.set(key, value); }, get: async key => secrets.get(key) ?? null, delete: async key => { secrets.delete(key); } };
  const provider: IdentityProvider = {
    begin: async () => ({ deviceCode: 'fixture-device', userCode: 'TEST-CODE', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 }),
    poll: async () => ({ status: 'authorized', accessToken: 'fixture-test-credential', expiresIn: 3600 }),
    verifyUser: async () => ({ id: '704', login: 'vault-fixture-owner', displayName: 'Vault Fixture Owner', avatarUrl: null }),
    listRepositories: async () => ({ repositories: [], truncated: false, checkedAt: new Date().toISOString() }),
  };
  let now = Date.now();
  const identity = new IdentityService({ registry: new IdentityRegistry(join(directory, 'identity.sqlite')), vault, provider, clientId: 'Iv1.vaultFixture', now: () => now });
  const instance = await createApp({ port: 4311, database: ':memory:', privateDirectory: join(directory, 'private'), identity, vault });
  const baseHeaders = { host: '127.0.0.1:4311', origin: 'http://127.0.0.1:4311' };
  const initial = await instance.app.inject({ method: 'POST', url: '/api/v1/session', headers: baseHeaders });
  let cookie = initial.cookies.map(item => `${item.name}=${item.value}`).join('; ');
  const start = await instance.app.inject({ method: 'POST', url: '/api/v1/auth/github/device/start', headers: { ...baseHeaders, cookie, 'x-csrf-token': initial.json().csrf } });
  now += 6000;
  const poll = await instance.app.inject({ method: 'POST', url: '/api/v1/auth/github/device/poll', payload: { flowId: start.json().flowId }, headers: { ...baseHeaders, cookie, 'x-csrf-token': initial.json().csrf } });
  cookie = poll.cookies.map(item => `${item.name}=${item.value}`).join('; ');
  const created = await instance.app.inject({ method: 'POST', url: '/api/v1/workspaces', payload: { name: 'Vault fixture workspace', kind: 'personal' }, headers: { ...baseHeaders, cookie, 'x-csrf-token': poll.json().session.csrf } });
  const workspaceId: string = created.json().workspace.id;
  const prefix = `/api/v1/workspaces/${workspaceId}`;
  const snapshot = async (): Promise<Snapshot> => (await instance.app.inject({ url: `${prefix}/snapshot`, headers: { ...baseHeaders, cookie } })).json();
  await page.exposeFunction('readVaultFixtureSnapshot', snapshot);
  await page.addInitScript(() => {
    localStorage.setItem('agent-town-reduced-motion', 'true');
    const readSnapshot = (window as unknown as { readVaultFixtureSnapshot(): Promise<{ cursor: number; state: { workspace: { id: string } } }> }).readVaultFixtureSnapshot;
    class FixtureEvents extends EventTarget {
      onopen: (() => void) | null = null;
      closed = false;
      cursor = -1;
      timer?: ReturnType<typeof setTimeout>;
      constructor(readonly url: string) { super(); this.timer = setTimeout(() => { if (!this.closed) { this.onopen?.(); void this.read(); } }, 0); }
      async read() {
        try {
          const saved = await readSnapshot();
          if (!this.closed && this.url.includes(`/workspaces/${saved.state.workspace.id}/`) && saved.cursor !== this.cursor) { this.cursor = saved.cursor; this.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(saved) })); }
        } finally { if (!this.closed) this.timer = setTimeout(() => void this.read(), 100); }
      }
      close() { this.closed = true; clearTimeout(this.timer); }
    }
    window.EventSource = FixtureEvents as unknown as typeof EventSource;
  });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== baseHeaders.origin) { await route.abort(); return; }
    if (!url.pathname.startsWith('/api/v1/')) { await route.continue(); return; }
    const response = await instance.app.inject({ method: request.method() as 'GET' | 'POST' | 'PATCH', url: `${url.pathname}${url.search}`, headers: { ...request.headers(), ...baseHeaders, cookie }, ...(request.postData() ? { payload: request.postData()! } : {}) });
    await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
  });
  const stop = async () => {
    try { if (!page.isClosed()) await page.close(); }
    finally {
      try { await instance.app.close(); }
      finally {
        try { profile.restore(); }
        finally {
          const full = resolve(directory);
          if (!full.startsWith(resolve(tmpdir()) + sep) || !full.includes('agent-town-vault-e2e-')) throw new Error('Unsafe fixture cleanup');
          rmSync(full, { recursive: true, force: true });
        }
      }
    }
  };
  return { projectPath, vaultDirectory, restoreDirectory, pageErrors, stop };
}

test('scans, blocks a real secret, backs up the safe files, and restores byte-identical content through the real UI and real service', async ({ page }, testInfo) => {
  const town = await realTown(page);
  try {
    await page.goto('/');
    await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Connect a project', exact: true }).click();
    const local = page.getByRole('region', { name: 'Local folders', exact: true });
    await local.getByLabel('Project folder', { exact: true }).fill(town.projectPath);
    await local.getByRole('button', { name: 'Add this project', exact: true }).click();
    const use = local.getByRole('button', { name: `Use ${town.projectPath} as a local project`, exact: true });
    await expect(use).toBeEnabled();
    await use.click();
    // The first connected project opens its own house details (a separate, right-side drawer) and
    // replaces the left Repositories drawer this test needs; close the house, then reopen Repositories.
    await expect(page.getByRole('dialog', { name: 'Vault fixture project', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close details', exact: true }).click();
    await page.getByRole('button', { name: 'Open repositories', exact: true }).click();

    const vaultSection = page.getByRole('region', { name: 'Project Vault', exact: true });
    await expect(vaultSection).toBeVisible();
    await vaultSection.getByRole('button', { name: /Project Vault/ }).click();
    await vaultSection.getByLabel('Local backup folder', { exact: true }).fill(town.vaultDirectory);
    await vaultSection.getByRole('button', { name: 'Turn on Project Vault', exact: true }).click();
    await expect(vaultSection.getByText(/Project Vault is on/)).toBeVisible();

    await vaultSection.getByRole('button', { name: 'Scan project files', exact: true }).click();
    await expect(vaultSection.getByText('app.js', { exact: true })).toBeVisible();
    await expect(vaultSection.getByText(/Likely secret on line 1 \(aws-access-key-id\)/)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('vault-scan.png') });

    // .env is gitignored and credential-shaped: never pre-selected. Confirm, then leave it unselected.
    const envRow = vaultSection.locator('li', { has: page.getByText('.env', { exact: true }) });
    await expect(envRow.getByRole('checkbox')).not.toBeChecked();

    await vaultSection.getByLabel(/Passphrase \(kept only on this request/).fill('a genuinely strong test passphrase');
    const backupButton = vaultSection.getByRole('button', { name: /Back up \d+ selected files?/ });
    await expect(backupButton).toBeEnabled();
    await backupButton.click();
    // app.js and .gitignore itself are both ordinary, non-ignored, non-sensitive files, so both are
    // pre-selected and backed up; only .env (gitignored and credential-shaped) is left out.
    await expect(vaultSection.getByText(/Backup complete: 2 files/)).toBeVisible();

    await vaultSection.getByRole('button', { name: 'Restore from a backup', exact: true }).click();
    await expect(vaultSection.getByText('Vault fixture project', { exact: true })).toBeVisible();
    // PV-02: the destination is now bound at preview time (not after), so it must be filled first.
    await vaultSection.getByLabel('Restore into this folder', { exact: true }).fill(town.restoreDirectory);
    await vaultSection.locator('.vault-restore').getByLabel('Passphrase', { exact: true }).fill('a genuinely strong test passphrase');
    await vaultSection.getByRole('button', { name: 'Preview this backup', exact: true }).click();
    await expect(vaultSection.getByText(/Vault fixture project: 2 files/)).toBeVisible();
    await expect(vaultSection.getByText(/Restoring into/)).toBeVisible();
    await vaultSection.getByRole('button', { name: /Restore \d+ files here/ }).click();
    await expect(vaultSection.getByText(/Restored 2 files/)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('vault-restored.png') });

    expect(readFileSync(join(town.restoreDirectory, 'app.js'), 'utf8')).toBe('console.log("hello from the vault fixture");\n');
    expect(town.pageErrors).toEqual([]);
  } finally { await town.stop(); }
});

test('PV-03: the workspace-level restore entry backs up, then restores with the original project fully disconnected and zero projects connected, offering an explicit Connect this folder afterward', async ({ page }, testInfo) => {
  const town = await realTown(page);
  try {
    await page.goto('/');
    await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Connect a project', exact: true }).click();
    const local = page.getByRole('region', { name: 'Local folders', exact: true });
    await local.getByLabel('Project folder', { exact: true }).fill(town.projectPath);
    await local.getByRole('button', { name: 'Add this project', exact: true }).click();
    const use = local.getByRole('button', { name: `Use ${town.projectPath} as a local project`, exact: true });
    await expect(use).toBeEnabled();
    await use.click();
    await expect(page.getByRole('dialog', { name: 'Vault fixture project', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close details', exact: true }).click();
    await page.getByRole('button', { name: 'Open repositories', exact: true }).click();

    const vaultSection = page.getByRole('region', { name: 'Project Vault', exact: true });
    await vaultSection.getByRole('button', { name: /Project Vault/ }).click();
    await vaultSection.getByLabel('Local backup folder', { exact: true }).fill(town.vaultDirectory);
    await vaultSection.getByRole('button', { name: 'Turn on Project Vault', exact: true }).click();
    await expect(vaultSection.getByText(/Project Vault is on/)).toBeVisible();
    await vaultSection.getByRole('button', { name: 'Scan project files', exact: true }).click();
    await expect(vaultSection.getByText('app.js', { exact: true })).toBeVisible();
    await vaultSection.getByLabel(/Passphrase \(kept only on this request/).fill('a genuinely strong test passphrase');
    await vaultSection.getByRole('button', { name: /Back up \d+ selected files?/ }).click();
    await expect(vaultSection.getByText(/Backup complete: 2 files/)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('vault-workspace-backup.png') });

    // Fully disconnect the original project (removing its allowed root cascades to disconnecting the
    // repository too) — PV-03's "disconnected original project" and "empty workspace entry" cases both
    // need this: the workspace-level restore below must still find and restore this backup with zero
    // projects connected, decoupled from any currently-open project's own id.
    await page.getByRole('button', { name: `Review removal of ${town.projectPath}`, exact: true }).click();
    await page.getByRole('button', { name: 'Remove allowed folder', exact: true }).click();
    await expect(page.getByText('Folder removed from discovery', { exact: false })).toBeVisible();

    const restoreEntry = vaultSection.getByRole('region', { name: 'Restore a project from Vault', exact: true });
    await expect(restoreEntry).toBeVisible();
    await restoreEntry.getByRole('button', { name: 'Restore a project from Vault', exact: true }).click();
    await expect(restoreEntry.getByRole('radio', { name: /Vault fixture project/ })).toBeVisible();
    await restoreEntry.getByRole('radio', { name: /Vault fixture project/ }).check();
    await restoreEntry.getByLabel('Restore into this folder', { exact: true }).fill(town.restoreDirectory);
    await restoreEntry.getByLabel('Passphrase', { exact: true }).fill('a genuinely strong test passphrase');
    await restoreEntry.getByRole('button', { name: 'Preview this backup', exact: true }).click();
    await expect(restoreEntry.getByText(/Vault fixture project: 2 files/)).toBeVisible();
    await restoreEntry.getByRole('button', { name: /Restore \d+ files here/ }).click();
    await expect(restoreEntry.getByText(/Restored 2 files/)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('vault-workspace-restored.png') });

    // Explicit, separate action — never automatic.
    const connectButton = restoreEntry.getByRole('button', { name: 'Connect this folder', exact: true });
    await expect(connectButton).toBeVisible();
    await connectButton.click();
    // The connected project is named after the restore DESTINATION folder's own basename ("restore-target"),
    // exactly like any other local-folder connection — not after the original backup's label ("Vault fixture
    // project"), which is a different folder path entirely (town.projectPath vs town.restoreDirectory).
    await expect(page.getByText(/Connected restore-target as a project/)).toBeVisible({ timeout: 15000 });

    expect(readFileSync(join(town.restoreDirectory, 'app.js'), 'utf8')).toBe('console.log("hello from the vault fixture");\n');
    expect(town.pageErrors).toEqual([]);
  } finally { await town.stop(); }
});
